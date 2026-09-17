-- Un `patron` incluye los tiempos, así que el mismo recorrido en hora punta y en
-- valle son patrones distintos: la línea 14 devolvía 80 recorridos.
--
-- El explorador no dibuja horas, dibuja paradas. Así que aquí se agrupa por
-- SECUENCIA DE PARADAS y se suman los viajes de todos los patrones que la
-- comparten. Si no, `veces` queda repartido entre variantes gemelas y el
-- desempate del cliente —que elige los dos sentidos— acaba cogiendo una variante
-- rara en vez del recorrido principal. Con esto la 14 pasa de 80 a 5.
create or replace function public.recorridos_de_linea(p_linea text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $function$
  with rutas as (
    select id from ruta where nombre = p_linea
  ), usos as (
    select v.patron, count(*) as veces
    from viaje v
    join rutas r on r.id = v.route_id
    group by v.patron
  ), secuencia as (
    select
      u.patron,
      u.veces,
      (select string_agg(pp.stop_id, ',' order by pp.orden)
         from patron_parada pp where pp.patron = u.patron) as clave
    from usos u
  ), recorridos as (
    select clave, sum(veces) as veces, min(patron) as patron
    from secuencia
    where clave is not null
    group by clave
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'patron', r.patron::text,
             'veces', r.veces,
             'paradas', (select jsonb_agg(pp.stop_id order by pp.orden)
                           from patron_parada pp where pp.patron = r.patron)
           )
           order by (length(r.clave) - length(replace(r.clave, ',', ''))) desc, r.veces desc
         ), '[]'::jsonb)
  from recorridos r;
$function$;

revoke all on function public.recorridos_de_linea(text) from public;
grant execute on function public.recorridos_de_linea(text) to anon, authenticated, service_role;
