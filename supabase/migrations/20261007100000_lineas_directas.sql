-- "¿A dónde vas?": las líneas que llevan de un sitio a otro SIN transbordo.
--
-- Una línea sirve si alguno de sus recorridos pasa por una parada de origen y,
-- MÁS ADELANTE en el mismo recorrido, por una de destino. El "más adelante"
-- (`b.orden > a.orden`) es lo que descarta el sentido contrario: la parada de
-- enfrente tiene el mismo nombre, pero el bus que para ahí va hacia el otro lado.
--
-- Combinar transbordos sería un planificador de rutas; eso ya lo hacen Google
-- Maps y el Journey Planner de TFI, y mejor que nosotros. Lo que no hacen es
-- lo de abajo: decir cuándo pasa el próximo QUE DE VERDAD LLEGA.
--
-- p_origen:  [{"id": "8220DB000270", "m": 120}, ...]   paradas y metros a pie
-- p_destino: ["8240DB005029", ...]
--
-- Por línea se queda el par (subir, bajar) que menos tarda contando el paseo a
-- 80 m/min. Y las próximas salidas se sacan de `llegada_actual` de esa parada,
-- pero solo de los viajes cuyo recorrido llega a la de bajar: un 41 que acaba
-- en Swords Pavilions no lleva a Swords Manor aunque se llame igual.
create or replace function public.lineas_directas(p_origen jsonb, p_destino text[])
returns jsonb
language sql
stable
set search_path to 'public'
as $function$
  with origen as (
    -- Con topes: son datos del cliente, y una lista enorme es una consulta lenta.
    select o.id, max(o.m) as m
    from (select * from jsonb_to_recordset(p_origen) as o(id text, m int) limit 60) o
    where o.id is not null
    group by o.id
  ), destino as (
    select distinct d.id from unnest(p_destino[1:120]) as d(id) where d.id is not null
  ), tramos as materialized (
    select a.patron, a.stop_id as sube, o.m, b.stop_id as baja,
           b.desfase - a.desfase as segs, b.orden - a.orden as paradas
    from origen o
    join patron_parada a on a.stop_id = o.id
    join patron_parada b on b.patron = a.patron and b.orden > a.orden
    join destino d on d.id = b.stop_id
  ), linea_patron as materialized (
    -- La línea se busca una vez por patrón, no por tramo: en el centro un
    -- mismo patrón da decenas de tramos (cada parada de origen con cada una de
    -- destino). Y va con LATERAL a propósito: el planner no sabe cuántos
    -- patrones salen de `tramos` (estimaba 11.600 y eran 104) y con un join
    -- normal se recorría `viaje` entera, 125.000 filas, 1,6 s.
    select p.patron, r.nombre as linea
    from (select distinct patron from tramos) p
    cross join lateral (select distinct v.route_id from viaje v where v.patron = p.patron) v
    join ruta r on r.id = v.route_id
  ), por_linea as (
    select lp.linea, t.*
    from tramos t
    join linea_patron lp on lp.patron = t.patron
  ), mejor as (
    select distinct on (linea) linea, sube, m, baja, segs, paradas
    from por_linea
    order by linea, m * 0.75 + segs, paradas
  ), validos as (
    -- Los recorridos de la línea que, desde esa parada de subida, llegan a
    -- ALGUNA del destino, no solo a la de la fila: con un sitio entero
    -- ("Swords"), un 41C que acaba en Swords Castle también te deja allí.
    select distinct l.linea, l.patron
    from por_linea l
    join mejor b on b.linea = l.linea and b.sube = l.sube
  ), salidas as (
    -- También LATERAL, por lo mismo: con un join el planner desplegaba las
    -- llegadas de las 5.428 paradas para quedarse con las de tres o cuatro.
    -- El `limit 1` no cambia nada (`stop_id` es la clave) pero impide que
    -- Postgres aplane la subconsulta y vuelva al join de antes.
    select b.linea, ll
    from mejor b
    cross join lateral (
      select la.llegadas from llegada_actual la where la.stop_id = b.sube limit 1
    ) la
    cross join lateral jsonb_array_elements(la.llegadas) ll
    where ll->>'linea' = b.linea
      and ll->>'estado' not in ('SALTADA', 'CANCELADO')
      and exists (
        select 1 from viaje v
        join validos va on va.patron = v.patron and va.linea = b.linea
        where v.trip_id = ll->>'tripId'
      )
  ), proximas as (
    select linea, jsonb_agg(ll order by (ll->>'minutos')::int) as lista
    from (
      select linea, ll,
             row_number() over (partition by linea order by (ll->>'minutos')::int) as n
      from salidas
    ) s
    where n <= 3
    group by linea
  )
  select coalesce(jsonb_agg(jsonb_build_object(
           'linea', b.linea,
           'sube', b.sube,
           'metros', b.m,
           'baja', b.baja,
           'segs', b.segs,
           'paradas', b.paradas,
           'proximas', coalesce(p.lista, '[]'::jsonb)
         )), '[]'::jsonb)
  from mejor b
  left join proximas p on p.linea = b.linea;
$function$;

revoke all on function public.lineas_directas(jsonb, text[]) from public;
grant execute on function public.lineas_directas(jsonb, text[]) to anon, authenticated, service_role;
