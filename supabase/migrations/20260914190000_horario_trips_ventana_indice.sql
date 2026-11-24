-- `jsonb_to_recordset` estima pocas filas y el planificador empezaba por
-- `stop_id`, agotando el statement timeout. El filtro explícito de trip fuerza
-- el índice horario(trip_id) antes de cruzar fechas y paradas.
create or replace function public.horario_de_trips_en_ventana_json(
  p_trip_ids text[],
  p_viajes jsonb,
  p_stop_ids text[],
  p_desde timestamptz,
  p_hasta timestamptz
)
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
  with viajes as materialized (
    select v.trip_id, v.start_date
    from jsonb_to_recordset(p_viajes) as v(trip_id text, start_date text)
    where v.trip_id is not null
      and v.start_date ~ '^[0-9]{8}$'
  ), horario_candidato as materialized (
    select h.stop_id, h.trip_id, h.seq, h.prog_segs, h.route_id
    from public.horario h
    where h.trip_id = any(p_trip_ids)
      and h.stop_id = any(p_stop_ids)
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
$$;

revoke all on function public.horario_de_trips_en_ventana_json(text[], jsonb, text[], timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.horario_de_trips_en_ventana_json(text[], jsonb, text[], timestamptz, timestamptz) to service_role;
