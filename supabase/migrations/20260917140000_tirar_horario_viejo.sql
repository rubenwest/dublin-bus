-- La vista `horario` devolvió la misma huella md5 que la tabla vieja sobre las
-- 860.010 filas (`557e1c3cf1cc3a3f7824a09f27d13ab5`) y la misma suma de
-- `prog_segs`, el cron lleva pasadas leyéndola sin enterarse y las consultas
-- salen 8,5x más rápidas. Ya no hace falta guardar los 144 MB.
--
-- `horario_de_trips` devolvía `SETOF horario`, o sea que dependía del TIPO de
-- fila de la tabla y la sujetaba: el DROP fallaba por ella. Se redefine con las
-- columnas escritas a mano —las mismas cinco— y así deja de depender de nada
-- que vaya a desaparecer.
drop function if exists public.horario_de_trips(text[]);

create or replace function public.horario_de_trips(trips text[])
returns table (stop_id text, trip_id text, seq integer, prog_segs integer, route_id text)
language sql
stable
security definer
set search_path to 'public', 'pg_temp'
as $function$
  select h.stop_id, h.trip_id, h.seq, h.prog_segs, h.route_id
  from public.horario h
  where h.trip_id = any(trips);
$function$;

revoke all on function public.horario_de_trips(text[]) from public, anon, authenticated;
grant execute on function public.horario_de_trips(text[]) to service_role;

drop table if exists horario_viejo;
