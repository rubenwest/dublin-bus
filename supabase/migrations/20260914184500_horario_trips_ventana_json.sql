-- No basta con filtrar por parada: los trips vivos aún incluyen muchas paradas
-- ya pasadas o lejanas. El rango incorpora el delay máximo aceptado para no
-- perder una llegada que pueda acabar dentro de la ventana de la web.
create or replace function public.horario_de_trips_en_ventana_json(
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
  with viajes as (
    select v.trip_id, v.start_date
    from jsonb_to_recordset(p_viajes) as v(trip_id text, start_date text)
    where v.trip_id is not null
      and v.start_date ~ '^[0-9]{8}$'
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
  from public.horario h
  join viajes v on v.trip_id = h.trip_id
  where h.stop_id = any(p_stop_ids)
    and (to_date(v.start_date, 'YYYYMMDD')::timestamp at time zone 'Europe/Dublin')
      + h.prog_segs * interval '1 second' between p_desde and p_hasta;
$$;

revoke all on function public.horario_de_trips_en_ventana_json(jsonb, text[], timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function public.horario_de_trips_en_ventana_json(jsonb, text[], timestamptz, timestamptz) to service_role;
