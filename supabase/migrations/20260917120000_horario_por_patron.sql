-- Adelgazar `horario` normalizando por patrón de recorrido.
--
-- El problema: `horario` guardaba una fila por (parada, viaje). Con 658 paradas
-- eran 860.010 filas y 144 MB de los 500 del plan gratuito. Ensanchar a las
-- 1.877 paradas del núcleo `8220DB` habría pedido ~410 MB, que no caben con
-- `serie` creciendo al lado. Y sin ensanchar, el explorador enseña la línea 14
-- recortada al centro y el buscador no encuentra las paradas de fuera de la caja.
--
-- El descubrimiento, medido sobre los datos reales: **72.593 viajes colapsan en
-- 7.364 patrones** si se guardan los tiempos como desfase desde la salida en vez
-- de como hora absoluta del viaje. Son 9,9 viajes por patrón. Sólo hay 437
-- secuencias de paradas distintas: lo que multiplica las filas no es la variedad
-- de recorridos, es que el mismo recorrido se repite cada pocos minutos.
--
-- Así que un viaje pasa a ser "el patrón P saliendo en el segundo S", y el
-- horario se reconstruye sumando. No se pierde ni un dato: `horario` sigue
-- existiendo como vista con las mismas cinco columnas, así que las RPC, la Edge
-- Function desplegada y el explorador siguen leyendo lo mismo que antes.
--
-- El id del patrón es el md5 de su contenido, no un `serial`, para que la subida
-- siga siendo idempotente: `sincronizar.mjs` puede recalcular el mismo patrón
-- mil veces y sale el mismo id, igual que hoy puede repetir un upsert sin miedo.

-- Un recorrido: qué paradas, en qué orden, y cuántos segundos después de salir.
create table if not exists patron (
  id      bigint primary key,
  paradas smallint not null
);

create table if not exists patron_parada (
  patron  bigint   not null references patron(id) on delete cascade,
  orden   smallint not null,          -- 0..n-1, la posición dentro del patrón
  stop_id text     not null,
  seq     integer  not null,          -- el stop_sequence crudo del GTFS
  desfase integer  not null,          -- prog_segs menos el de la primera parada
  primary key (patron, orden)
);

-- Un viaje concreto: el patrón, y a qué segundo del día arranca.
-- `route_id` sube aquí desde `horario`: dependía del viaje, no de la parada, y
-- se repetía en cada una de sus filas.
create table if not exists viaje (
  trip_id  text   primary key,
  patron   bigint not null references patron(id),
  sale     integer not null,          -- prog_segs de la primera parada del patrón
  route_id text
);

-- Buscar por parada (el explorador, los diagnósticos) y por ruta (los sentidos
-- de una línea). La PK de `viaje` ya cubre la búsqueda por trip_id, que es la
-- que usa la Edge Function en cada pasada del cron.
create index if not exists patron_parada_stop on patron_parada (stop_id);
create index if not exists viaje_patron on viaje (patron);
create index if not exists viaje_route on viaje (route_id);

-- ---------------------------------------------------------------------------
-- Relleno desde la tabla vieja.
-- ---------------------------------------------------------------------------

-- Tablas de apoyo normales, no temporales: así el relleno no depende de cómo
-- envuelva la migración en transacciones el cliente que la aplique. Se tiran al
-- final.
--
-- El desfase se mide contra la PRIMERA parada por `seq`, no contra el mínimo
-- `prog_segs`: es lo que significa "sale". Coinciden salvo que el estático traiga
-- un horario no monótono, y en ese caso la definición buena es la del orden.
create table mig_relativo as
select
  h.trip_id,
  h.stop_id,
  h.seq,
  h.prog_segs,
  h.route_id,
  first_value(h.prog_segs) over (partition by h.trip_id order by h.seq) as sale,
  row_number()  over (partition by h.trip_id order by h.seq) - 1        as orden
from horario h;

create table mig_firma as
select
  trip_id,
  min(sale) as sale,
  -- `route_id` era columna de fila y venía a NULL en las paradas dadas de alta
  -- por la versión vieja de `--horario`. Al subirlo al viaje, 2.090 viajes
  -- recuperan su ruta porque la traía alguna de sus otras paradas.
  max(route_id) as route_id,
  string_agg(stop_id || ':' || seq || ':' || (prog_segs - sale), ',' order by orden) as texto
from mig_relativo
group by trip_id;

-- md5 truncado a 60 bits. `sincronizar.mjs` calcula exactamente lo mismo en
-- Node; si alguna vez cambia la fórmula hay que cambiarla en los dos sitios.
insert into patron (id, paradas)
select
  ('x' || substr(md5(f.texto), 1, 15))::bit(60)::bigint,
  (length(f.texto) - length(replace(f.texto, ',', '')) + 1)::smallint
from (select distinct texto from mig_firma) f
on conflict (id) do nothing;

insert into patron_parada (patron, orden, stop_id, seq, desfase)
select distinct
  ('x' || substr(md5(f.texto), 1, 15))::bit(60)::bigint,
  r.orden::smallint,
  r.stop_id,
  r.seq,
  r.prog_segs - r.sale
from mig_relativo r
join mig_firma f on f.trip_id = r.trip_id
on conflict (patron, orden) do nothing;

insert into viaje (trip_id, patron, sale, route_id)
select
  f.trip_id,
  ('x' || substr(md5(f.texto), 1, 15))::bit(60)::bigint,
  f.sale,
  f.route_id
from mig_firma f
on conflict (trip_id) do update
  set patron = excluded.patron, sale = excluded.sale, route_id = excluded.route_id;

-- ---------------------------------------------------------------------------
-- `horario` pasa a ser una vista con las mismas columnas de siempre.
-- ---------------------------------------------------------------------------

alter table horario rename to horario_viejo;

create view horario as
select
  pp.stop_id,
  v.trip_id,
  pp.seq,
  v.sale + pp.desfase as prog_segs,
  v.route_id
from viaje v
join patron_parada pp on pp.patron = v.patron;

-- La vista es de lectura pública como lo era la tabla; escribir sigue sin
-- política, o sea sólo `service_role`.
grant select on horario to anon, authenticated;
grant select on patron, patron_parada, viaje to anon, authenticated;

alter table patron        enable row level security;
alter table patron_parada enable row level security;
alter table viaje         enable row level security;

create policy patron_lectura        on patron        for select to anon, authenticated using (true);
create policy patron_parada_lectura on patron_parada for select to anon, authenticated using (true);
create policy viaje_lectura         on viaje         for select to anon, authenticated using (true);

drop table mig_relativo;
drop table mig_firma;

-- `horario_viejo` se queda hasta comprobar que la vista devuelve exactamente lo
-- mismo. Se tira en la migración siguiente, no aquí: 144 MB no se borran a
-- ciegas.
