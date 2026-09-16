-- La `n` anterior contaba PREDICCIONES, no autobuses. Cada paso deja ~20
-- predicciones sucesivas del mismo bus, correlacionadas entre si: la celda del
-- E2 en Dun Laoghaire a las 10h decia n=915 siendo 43 autobuses. Eso prometia
-- una confianza 20 veces mayor que la real, y ademas ponderaba cada bus por
-- cuantas veces se le hubiera sondeado.
--
-- Ahora se colapsa primero a UNA fila por (parada, linea, bus, dia) y se agrega
-- sobre eso, asi cada autobus pesa uno. De las predicciones de ese paso se
-- elige la mas lejana dentro de la ventana de consulta: es la lectura util y la
-- conservadora ("aun a 9 minutos vista seguia diciendo +3"). Las predicciones a
-- una hora vista son malas y no las mira nadie; meterlas infla el sesgo (esa
-- misma celda pasaba de +0,1 a +3,1 min solo por incluirlas).
create or replace view paso_predicho as
select distinct on (e.stop_id, e.route_id, e.trip_id, e.fecha_servicio)
    e.stop_id,
    e.route_id,
    e.trip_id,
    e.fecha_servicio,
    e.franja_hora,
    e.dia_semana,
    e.error_segundos,
    e.delay_real,
    e.anticipacion_min
  from error_prediccion e
  -- Ventana de consulta: lo que ve alguien mirando la app en el cuarto de hora
  -- anterior al bus. Fuera de ella no se mide fiabilidad, se mide el horario.
  where e.anticipacion_min > 0 and e.anticipacion_min <= 15
  order by e.stop_id, e.route_id, e.trip_id, e.fecha_servicio, e.anticipacion_min desc;

drop view fiabilidad;

create view fiabilidad as
select
    p.stop_id,
    pa.nombre as parada,
    p.route_id,
    -- `route_id` es el identificador crudo del GTFS ("1 E2 a"); la web ensena
    -- el nombre corto, que es el que casa con `llegada_actual.llegadas[].linea`.
    r.nombre as linea,
    p.franja_hora,
    count(*) as n,                              -- autobuses distintos
    count(distinct p.fecha_servicio) as dias,
    round((percentile_cont(0.5) within group (order by p.error_segundos) / 60.0)::numeric, 1) as sesgo_min,
    round((percentile_cont(0.5) within group (order by abs(p.error_segundos)) / 60.0)::numeric, 1) as error_abs_min,
    round((percentile_cont(0.9) within group (order by p.error_segundos) / 60.0)::numeric, 1) as p90_min,
    round((percentile_cont(0.5) within group (order by p.delay_real) / 60.0)::numeric, 1) as retraso_medio_min
  from paso_predicho p
  left join parada pa on pa.id = p.stop_id
  left join ruta r on r.id = p.route_id
  group by p.stop_id, pa.nombre, p.route_id, r.nombre, p.franja_hora;

comment on view fiabilidad is
  'Sesgo de la prediccion por (parada, linea, franja horaria). n = autobuses distintos, no predicciones.';

grant select on paso_predicho, fiabilidad to anon, authenticated;
