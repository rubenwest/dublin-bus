-- El catálogo de líneas enseñaba chips pelados ("41C") y con 200 líneas eso no
-- se recorre: quien no se sabe el número no tiene por dónde entrar. El GTFS
-- trae en `route_long_name` los extremos del recorrido ("Swords Manor Via
-- River Valley - Lower Abbey St"), que es a la vez lo que hay que enseñar y lo
-- que permite buscar "Swords" en vez de un número.
alter table public.ruta add column if not exists nombre_largo text;

-- Una fila por línea del catálogo, con su recorrido. Hace falta agrupar porque
-- el nombre corto no es único en Irlanda: el "14" de Dublin Bus (Dundrum -
-- Beaumont) y el "14" de Bus Éireann (Limerick - Killarney) comparten nombre.
-- Se queda el recorrido de la ruta con más viajes cargados, que es la que de
-- verdad pasa por las paradas en vivo; una ruta sin viajes no entra.
create or replace view public.linea_catalogo
with (security_invoker = true) as
select r.nombre as linea,
       (array_agg(r.nombre_largo order by v.n desc))[1] as recorrido
from public.ruta r
join (select route_id, count(*) as n from public.viaje group by route_id) v
  on v.route_id = r.id
where r.nombre_largo is not null and r.nombre_largo <> ''
group by r.nombre;

grant select on public.linea_catalogo to anon, authenticated;
