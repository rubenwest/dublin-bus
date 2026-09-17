-- El explorador de líneas leía `horario` a pelo y paginaba de 1.000 en 1.000.
-- Para la línea 14 son 1.058 viajes por sus paradas: 16 peticiones para acabar
-- pintando 15 nodos. Con las paradas del núcleo entero serían ~63.000 filas y
-- 63 peticiones, que es directamente inviable desde el móvil.
--
-- Pero el explorador nunca quiso los viajes: quiere los RECORRIDOS, y eso es
-- exactamente lo que ahora es un `patron`. La 14 tiene 1.058 viajes y 4 patrones.
-- Se piden los patrones, no los viajes, y se acabó la paginación.
--
-- `veces` (cuántos viajes usan el patrón) se devuelve porque el cliente lo usa
-- para desempatar: entre dos recorridos de la misma longitud, el que más se
-- repite es el principal y el otro es la variante rara.
--
-- El id del patrón sale como texto a propósito: es de 60 bits y un `number` de
-- JavaScript sólo garantiza 53. El cliente lo trata como opaco.
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
  ), recorridos as (
    select
      u.patron,
      u.veces,
      (select jsonb_agg(pp.stop_id order by pp.orden)
         from patron_parada pp where pp.patron = u.patron) as paradas,
      (select count(*) from patron_parada pp where pp.patron = u.patron) as largo
    from usos u
  )
  select coalesce(jsonb_agg(
           jsonb_build_object(
             'patron', patron::text,
             'veces', veces,
             'paradas', paradas
           )
           order by largo desc, veces desc
         ), '[]'::jsonb)
  from recorridos
  where paradas is not null;
$function$;

-- Lectura pública, igual que la vista `horario` de la que sale.
revoke all on function public.recorridos_de_linea(text) from public;
grant execute on function public.recorridos_de_linea(text) to anon, authenticated, service_role;
