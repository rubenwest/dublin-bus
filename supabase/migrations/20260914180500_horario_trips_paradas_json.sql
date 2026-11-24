-- El resultado completo de todos los trips vivos es demasiado grande para una
-- Edge Function del plan gratuito. Filtrar por las paradas que se sirven antes
-- de agregar mantiene el payload pequeño y sigue evitando el límite tabular de
-- 1.000 filas de PostgREST.
create or replace function public.horario_de_trips_en_paradas_json(
  p_trips text[],
  p_stop_ids text[]
)
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
  where h.trip_id = any(p_trips)
    and h.stop_id = any(p_stop_ids);
$$;

revoke all on function public.horario_de_trips_en_paradas_json(text[], text[]) from public, anon, authenticated;
grant execute on function public.horario_de_trips_en_paradas_json(text[], text[]) to service_role;
