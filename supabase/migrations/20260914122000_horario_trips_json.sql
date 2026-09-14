-- Devuelve el horario de los viajes vivos en un único valor JSONB.
-- PostgREST limita los resultados tabulares a 1.000 filas; el agregado evita
-- que el recolector pierda paradas al ampliar la cobertura.
create or replace function public.horario_de_trips_json(p_trips text[])
returns jsonb
language sql
stable
security definer
set search_path = public
as $$
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
  where h.trip_id = any(p_trips);
$$;

revoke all on function public.horario_de_trips_json(text[]) from public, anon, authenticated;
grant execute on function public.horario_de_trips_json(text[]) to service_role;
