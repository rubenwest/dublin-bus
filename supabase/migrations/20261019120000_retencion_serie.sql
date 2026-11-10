-- Retención de `serie` (2026-10-19).
--
-- La base llegó a 889 MB con un tope de 500 (el plan gratuito pasa a solo
-- lectura, y entonces el cron deja de escribir y se pierde histórico). `serie`
-- ocupaba 625 MB: con 20 paradas son ~110.000 tramos por día laborable,
-- ~31 MB/día contando índices, cuatro veces lo que se había estimado.
--
-- `fiabilidad` no necesita el crudo: agrega `paso_predicho`, que tiene UNA fila
-- por autobús, parada y día. Así que lo viejo se archiva a esa granularidad
-- (`paso_archivado`, ~7.500 filas/día, ~1 MB) y el crudo se borra pasados
-- unos días. `paso_predicho` pasa a ser crudo reciente + archivo, y
-- `fiabilidad` sale idéntica porque agrega exactamente las mismas filas.
--
-- Lo que se pierde de lo viejo: `error_prediccion` y `paso_medido` completos
-- (todas las predicciones de cada bus, no sólo la que usa `fiabilidad`). Para
-- eso está `scripts/exportar-serie.mjs`, que vuelca el crudo a disco.
--
-- Fuera de esta migración, porque son de una sola vez o no pueden ir en una
-- transacción (ver CLAUDE.md, "Retención de serie"): la primera poda día a
-- día, el VACUUM FULL de `serie` y vaciar `cron.job_run_details`.

-- 1. Índice duplicado: mismas columnas y mismo orden que `serie_tramo_unico`
--    (que además es el único, el que usa el upsert de `ingerir`). 127 MB.
drop index if exists public.serie_paso;

-- 2. El archivo.
create table if not exists public.paso_archivado (
  stop_id text not null,
  route_id text,
  trip_id text not null,
  fecha_servicio date not null,
  franja_hora integer,
  dia_semana integer,
  error_segundos integer,
  delay_real integer,
  anticipacion_min numeric,
  -- La clave de `paso_predicho` (su DISTINCT ON). `nulls not distinct`
  -- porque `route_id` puede venir vacío y el archivado tiene que seguir
  -- siendo idempotente.
  constraint paso_archivado_unico unique nulls not distinct (stop_id, route_id, trip_id, fecha_servicio)
);

alter table public.paso_archivado enable row level security;
drop policy if exists paso_archivado_lectura_publica on public.paso_archivado;
create policy paso_archivado_lectura_publica on public.paso_archivado
  for select to anon, authenticated using (true);

-- 3. `paso_predicho` tal como era, sobre el crudo, con otro nombre.
create or replace view public.paso_predicho_crudo as
 SELECT DISTINCT ON (stop_id, route_id, trip_id, fecha_servicio) stop_id,
    route_id,
    trip_id,
    fecha_servicio,
    franja_hora,
    dia_semana,
    error_segundos,
    delay_real,
    anticipacion_min
   FROM error_prediccion e
  WHERE ((anticipacion_min > (0)::numeric) AND (anticipacion_min <= (15)::numeric))
  ORDER BY stop_id, route_id, trip_id, fecha_servicio, anticipacion_min DESC;

revoke all on public.paso_predicho_crudo from anon, authenticated;

-- Y `paso_predicho`, con las mismas columnas: crudo reciente + archivo.
-- No se solapan: `podar_serie` archiva y borra el mismo día en la misma
-- transacción.
create or replace view public.paso_predicho as
 SELECT stop_id, route_id, trip_id, fecha_servicio, franja_hora, dia_semana,
    error_segundos, delay_real, anticipacion_min
   FROM paso_predicho_crudo
UNION ALL
 SELECT stop_id, route_id, trip_id, fecha_servicio, franja_hora, dia_semana,
    error_segundos, delay_real, anticipacion_min
   FROM paso_archivado;

-- 4. La poda: archiva y borra los días de servicio anteriores a hoy - p_dias.
--    Día a día, para que cada DELETE sea de ~110.000 filas y no de millones.
create or replace function public.podar_serie(p_dias integer default 3)
returns jsonb
language plpgsql
set search_path = public
as $$
declare
  corte date := (now() at time zone 'Europe/Dublin')::date - p_dias;
  d date;
  n bigint;
  archivados bigint := 0;
  borrados bigint := 0;
  dias int := 0;
begin
  -- El día de servicio de ayer aún tiene viajes "25:10:00" en curso de
  -- madrugada: archivarlo daría un `paso_predicho` incompleto.
  if p_dias < 2 then
    raise exception 'podar_serie: p_dias tiene que ser >= 2 (es %)', p_dias;
  end if;

  for d in select distinct fecha_servicio from serie where fecha_servicio < corte order by 1 loop
    insert into paso_archivado (stop_id, route_id, trip_id, fecha_servicio, franja_hora,
                                dia_semana, error_segundos, delay_real, anticipacion_min)
    select stop_id, route_id, trip_id, fecha_servicio, franja_hora,
           dia_semana, error_segundos, delay_real, anticipacion_min
      from paso_predicho_crudo
     where fecha_servicio = d
    on conflict do nothing;
    get diagnostics n = row_count;
    archivados := archivados + n;

    delete from serie where fecha_servicio = d;
    get diagnostics n = row_count;
    borrados := borrados + n;
    dias := dias + 1;
  end loop;

  return jsonb_build_object('corte', corte, 'dias', dias,
                            'archivados', archivados, 'borrados', borrados);
end;
$$;

revoke execute on function public.podar_serie(integer) from public, anon, authenticated;

-- 5. Los dos crons de limpieza, de madrugada (pg_cron va en UTC).
--    `cron.job_run_details` guarda una fila por pasada: 1.500 al día con el
--    cron de cada minuto, y nadie la poda si no se le dice (Supabase lo
--    recomienda así en su guía de pg_cron).
select cron.schedule('podar-serie', '15 3 * * *', $$select public.podar_serie(3)$$);
select cron.schedule('podar-historial-cron', '30 3 * * *',
  $$delete from cron.job_run_details where end_time < now() - interval '3 days'$$);
