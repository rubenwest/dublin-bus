-- Posiciones GPS del feed Vehicles, para ensenar donde esta el bus que se
-- espera. NO es historico y NO crece: son ~800 filas que se reescriben cada
-- minuto. El historico vive en `serie` y esto no lo toca.
--
-- Vehicles viene capado (solo lat/lon/bearing, sin current_stop_sequence ni
-- stop_id), asi que no sirve para calcular llegadas; sirve para pintar el
-- punto. Y se cruza por `trip_id`, NUNCA por `vehicle.id`: los ids de los dos
-- feeds son espacios de nombres distintos ("3" aqui, "7182" alli).
create table if not exists vehiculo (
  trip_id text primary key,
  route_id text,
  lat double precision not null,
  lon double precision not null,
  -- El rumbo es opcional en la spec y la NTA lo manda a ratos: medido sobre el
  -- feed real, solo 253 de 789 vehiculos lo traian. Nada puede depender de el.
  bearing double precision,
  -- Momento de la medida segun el propio feed, que es lo que permite decir
  -- "hace 40 s" sin fiarse del reloj del movil.
  ts timestamptz,
  visto timestamptz not null default now()
);

-- Para barrer los que dejan de emitir sin recorrer la tabla por trip_id.
create index if not exists vehiculo_visto_idx on vehiculo (visto);

alter table vehiculo enable row level security;

-- Mismo criterio que el resto: lectura publica, ninguna politica de escritura.
-- Solo la service_role escribe, porque se salta RLS por diseno.
drop policy if exists vehiculo_lectura on vehiculo;
create policy vehiculo_lectura on vehiculo for select to anon, authenticated using (true);

grant select on vehiculo to anon, authenticated;
