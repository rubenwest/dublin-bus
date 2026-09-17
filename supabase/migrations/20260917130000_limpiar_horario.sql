-- Cuando se recarga el horario con otra cobertura (más paradas, o un estático
-- nuevo), los viajes de la carga anterior se quedan ahí: el upsert añade y
-- actualiza, pero no borra lo que ya no toca. Con los `trip_id` cambiando en
-- cada versión del estático eso se acumula carga tras carga.
--
-- `cargado` marca de qué pasada es cada viaje. `sincronizar.mjs` pone la misma
-- marca en todas las filas que sube, y al terminar llama a `limpiar_horario()`
-- con ella: lo que quedó por debajo es de una carga vieja y se va, y detrás se
-- van los patrones que ya no usa nadie.
--
-- El borrado va al final y por separado a propósito. Mientras sube la carga
-- nueva conviven las dos, así que el cron de cada minuto nunca se queda sin
-- horario que consultar.
alter table viaje add column if not exists cargado timestamptz not null default now();

create index if not exists viaje_cargado on viaje (cargado);

create or replace function public.limpiar_horario(p_desde timestamptz)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $function$
declare
  v_viajes  bigint;
  v_patrones bigint;
begin
  delete from viaje where cargado < p_desde;
  get diagnostics v_viajes = row_count;

  delete from patron p
  where not exists (select 1 from viaje v where v.patron = p.id);
  get diagnostics v_patrones = row_count;

  return jsonb_build_object('viajes_borrados', v_viajes, 'patrones_borrados', v_patrones);
end;
$function$;

-- Sólo escribe la service_role: esto borra.
revoke all on function public.limpiar_horario(timestamptz) from public, anon, authenticated;
grant execute on function public.limpiar_horario(timestamptz) to service_role;
