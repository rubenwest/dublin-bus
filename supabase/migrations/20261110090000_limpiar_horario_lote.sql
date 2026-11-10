-- Barrido del horario por lotes.
--
-- `limpiar_horario` borra todo de una vez y con la carga completa (~170k viajes
-- de dos cargas conviviendo) pasa del statement_timeout del rol authenticator
-- (8 s): el 2026-11-09 la carga subió bien y el barrido final falló con 57014,
-- dejando las dos cargas mezcladas. Esta versión borra como mucho `p_max`
-- viajes y `p_max` patrones huérfanos por llamada; quien la llama repite hasta
-- que devuelve 0 y 0.

create or replace function public.limpiar_horario_lote(p_desde timestamptz, p_max int default 5000)
returns jsonb
language plpgsql
security definer
set search_path to 'public'
as $$
declare
  v_viajes   bigint;
  v_patrones bigint;
begin
  with b as (select trip_id from viaje where cargado < p_desde limit p_max)
  delete from viaje x using b where x.trip_id = b.trip_id;
  get diagnostics v_viajes = row_count;

  delete from patron q
  where q.id in (
    select p.id from patron p
    where not exists (select 1 from viaje w where w.patron = p.id)
    limit p_max
  );
  get diagnostics v_patrones = row_count;

  return jsonb_build_object('viajes_borrados', v_viajes, 'patrones_borrados', v_patrones);
end;
$$;

revoke execute on function public.limpiar_horario_lote(timestamptz, int) from public, anon, authenticated;
grant execute on function public.limpiar_horario_lote(timestamptz, int) to service_role;
