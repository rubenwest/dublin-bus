-- Para agrupar el catálogo de líneas (Luas, tren, BusConnects, interurbanos…)
-- hace falta saber qué es cada una, y el nombre corto no basta: el "S2" puede
-- ser un orbital de Dublin Bus o un regional de Sligo. Se guardan dos campos
-- del GTFS tal cual y la web decide el grupo:
--   tipo    = route_type (0 tranvía, 2 tren, 3 autobús)
--   agencia = agency_id ("1" Dublin Bus, "3" Go-Ahead Dublín, "2" Bus Éireann,
--             "03C" Go-Ahead de cercanías, "IR" Irish Rail, "10000" Luas…)
alter table public.ruta add column if not exists tipo smallint;
alter table public.ruta add column if not exists agencia text;

-- Mismo criterio que el recorrido: los datos son los de la ruta con más
-- viajes cargados, la que de verdad pasa por las paradas en vivo. Las
-- columnas nuevas van al final porque `create or replace view` no deja
-- reordenar las que ya había.
create or replace view public.linea_catalogo
with (security_invoker = true) as
select r.nombre as linea,
       (array_agg(r.nombre_largo order by v.n desc))[1] as recorrido,
       (array_agg(r.tipo order by v.n desc))[1] as tipo,
       (array_agg(r.agencia order by v.n desc))[1] as agencia
from public.ruta r
join (select route_id, count(*) as n from public.viaje group by route_id) v
  on v.route_id = r.id
where r.nombre_largo is not null and r.nombre_largo <> ''
group by r.nombre;
