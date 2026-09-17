-- El `stop_id = any(p_stop_ids)` de la version anterior se resolvia con un
-- BitmapAnd sobre `patron_parada_stop`, y ese bitmap se reconstruia UNA VEZ POR
-- TRIP VIVO: 2.300 loops leyendo 272.868 filas cada uno, 1,14 M de buffers,
-- 26 s. Con 658 paradas pasaba justo; con 1.968 se paso del statement_timeout y
-- el cron entero empezo a devolver 500 (medido en los logs: todas las pasadas
-- desde las 13:33 UTC del 2026-09-17).
--
-- Cruzar contra `unnest(...)` en vez de usar `= any(...)` deja al planner hacer
-- un hash join: el filtro de paradas se aplica UNA vez sobre las 36.076 filas
-- que salen de los trips, no 2.300 veces sobre el indice entero.
-- Medido sobre las mismas 36.076 filas: 26.186 ms -> 172 ms.
--
-- La firma no cambia, asi que la Edge Function no necesita redespliegue.
create or replace function public.horario_de_trips_en_ventana_json(
  p_trip_ids text[],
  p_viajes jsonb,
  p_stop_ids text[],
  p_desde timestamptz,
  p_hasta timestamptz
) returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with viajes as materialized (
    select v.trip_id, v.start_date
    from jsonb_to_recordset(p_viajes) as v(trip_id text, start_date text)
    where v.trip_id is not null
      and v.start_date ~ '^[0-9]{8}$'
  ), horario_candidato as materialized (
    select h.stop_id, h.trip_id, h.seq, h.prog_segs, h.route_id
    from public.horario h
    join unnest(p_trip_ids) as t(trip_id) on t.trip_id = h.trip_id
    join unnest(p_stop_ids) as s(stop_id) on s.stop_id = h.stop_id
  )
  select coalesce(
    jsonb_agg(
      jsonb_build_object(
        'stop_id', h.stop_id,
        'trip_id', h.trip_id,
        'seq', h.seq,
        'prog_segs', h.prog_segs,
        'route_id', h.route_id
      )
      order by h.trip_id, h.seq, h.stop_id
    ),
    '[]'::jsonb
  )
  from horario_candidato h
  join viajes v on v.trip_id = h.trip_id
  where (to_date(v.start_date, 'YYYYMMDD')::timestamp at time zone 'Europe/Dublin')
    + h.prog_segs * interval '1 second' between p_desde and p_hasta;
$function$;

revoke execute on function public.horario_de_trips_en_ventana_json(text[], jsonb, text[], timestamptz, timestamptz) from public, anon;
grant execute on function public.horario_de_trips_en_ventana_json(text[], jsonb, text[], timestamptz, timestamptz) to service_role;
