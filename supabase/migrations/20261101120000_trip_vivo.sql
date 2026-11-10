-- El feed vivo se guarda y las llegadas se calculan cuando alguien mira una
-- parada. Antes la Edge Function se bajaba el horario en cada pasada (~10 MB por
-- minuto) y agotó el egress del plan gratuito. Escribir no gasta egress; leer sí.

create table if not exists public.trip_vivo (
  trip_id    text primary key,
  start_date text not null,
  rel        text not null default 'SCHEDULED',
  route_id   text,
  vehiculo   text,
  updates    jsonb not null,
  feed_ts    bigint not null,
  visto      timestamptz not null default now()
);

-- Sin políticas: la tabla entera no se sirve a nadie. Se lee por la RPC.
alter table public.trip_vivo enable row level security;

-- Recorta los updates de un trip a los que deciden el estado de una parada:
-- desde la más cercana hacia atrás, hasta la primera con delay o NO_DATA. Es
-- donde `estadoParadaPreparado` deja de mirar, así que el resultado no cambia y
-- una fila pasa de ~40 updates a 1 o 2.
create or replace function public.updates_para_parada(p_updates jsonb, p_seq int)
returns jsonb
language sql
immutable
as $$
  with previos as (
    select e as u, (e->>'stop_sequence')::int as seq
    from jsonb_array_elements(p_updates) as e
    where (e->>'stop_sequence')::int <= p_seq
  )
  select coalesce(jsonb_agg(u order by seq desc), '[]'::jsonb)
  from previos
  where seq >= coalesce(
    (select max(seq) from previos
     where u->>'schedule_relationship' = 'NO_DATA' or u->'arrival' ? 'delay'),
    -1
  );
$$;

create or replace function public.llegadas_de_parada(p_stop text)
returns jsonb
language sql
stable
security definer
set search_path to 'public'
as $$
  select jsonb_build_object(
    'parada', (
      select jsonb_build_object('id', p.id, 'nombre', p.nombre, 'lat', p.lat, 'lon', p.lon)
      from public.parada p where p.id = p_stop
    ),
    'feed_ts', (select max(t.feed_ts) from public.trip_vivo t),
    'generado', (select max(t.visto) from public.trip_vivo t),
    'viajes', coalesce((
      select jsonb_agg(jsonb_build_object(
        'trip_id', v.trip_id,
        'start_date', v.start_date,
        'rel', v.rel,
        'linea', coalesce(r.nombre, v.route_id, h.route_id),
        'vehiculo', v.vehiculo,
        'seq', h.seq,
        'prog_segs', h.prog_segs,
        'updates', public.updates_para_parada(v.updates, h.seq)
      ))
      from public.horario h
      join public.trip_vivo v on v.trip_id = h.trip_id
      left join public.ruta r on r.id = coalesce(v.route_id, h.route_id)
      where h.stop_id = p_stop
        -- Ventana de la web (-2, +90 min) más el delay máximo admitido, 45 min.
        and (to_date(v.start_date, 'YYYYMMDD')::timestamp at time zone 'Europe/Dublin')
          + h.prog_segs * interval '1 second'
          between now() - interval '47 minutes' and now() + interval '135 minutes'
    ), '[]'::jsonb)
  );
$$;

revoke all on function public.llegadas_de_parada(text) from public;
grant execute on function public.llegadas_de_parada(text) to anon, authenticated, service_role;

-- La vigilancia mira el feed guardado: si no se renueva, y si sus viajes casan
-- con el horario cargado. Lo segundo es justo lo que rompe un estático nuevo.
create or replace function public.vigilar_llegadas(p_umbral numeric default 0.5)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault', 'net', 'extensions'
as $function$
declare
  total   int;
  con     int;
  ultima  timestamptz;
  hora    int := extract(hour from now() at time zone 'Europe/Dublin');
  motivo  text;
  asunto  text;
  cuerpo  text;
  clave   text;
begin
  select count(*), count(v.trip_id), max(t.visto)
    into total, con, ultima
  from trip_vivo t
  left join viaje v on v.trip_id = t.trip_id;

  if ultima is null or ultima < now() - interval '15 minutes' then
    motivo := 'rancio';
    asunto := 'Dublin Bus: las llegadas no se actualizan';
    cuerpo := 'trip_vivo no se reescribe desde ' ||
              coalesce(to_char(ultima at time zone 'Europe/Dublin', 'YYYY-MM-DD HH24:MI'), 'nunca') ||
              ' (Dublín).' || E'\n\n' ||
              'Mirar cron.job_run_details y net._http_response: el cron o la ' ||
              'Edge Function recolectar están fallando.';
  elsif hora >= 8 and hora < 20 and total > 0 and con < total * p_umbral then
    motivo := 'cobertura';
    asunto := 'Dublin Bus: solo ' || con || ' de ' || total || ' viajes casan con el horario';
    cuerpo := 'Solo ' || con || ' de ' || total || ' viajes vivos están en el horario cargado (' ||
              round(100.0 * con / total) || '%).' || E'\n\n' ||
              'Lo más probable es que la NTA haya publicado un estático nuevo:' || E'\n\n' ||
              '  1. bajar GTFS_Realtime.zip y descomprimirlo en gtfs/' || E'\n' ||
              '  2. node scripts\indexar.mjs .\gtfs .\indice' || E'\n' ||
              '  3. node scripts\sincronizar.mjs --nucleo' || E'\n' ||
              '  4. node scripts\trazados.mjs y node scripts\codigos-parada.mjs';
  else
    delete from alerta_estado;
    return 'ok ' || con || '/' || total;
  end if;

  if exists (select 1 from alerta_estado a
             where a.clave = motivo and a.avisado > now() - interval '12 hours') then
    return motivo || ' (ya avisado)';
  end if;

  select decrypted_secret into clave
  from vault.decrypted_secrets
  where name = 'resend_api_key';

  if clave is null then
    raise warning 'vigilar_llegadas: falta el secreto resend_api_key en Vault';
    return motivo || ' (sin clave)';
  end if;

  perform net.http_post(
    url     := 'https://api.resend.com/emails',
    headers := jsonb_build_object(
      'Content-Type',  'application/json',
      'Authorization', 'Bearer ' || clave
    ),
    body := jsonb_build_object(
      'from',    'Dublin Bus <onboarding@resend.dev>',
      'to',      jsonb_build_array('rubensg90@gmail.com'),
      'subject', asunto,
      'text',    cuerpo
    ),
    timeout_milliseconds := 10000
  );

  insert into alerta_estado (clave, avisado) values (motivo, now())
  on conflict on constraint alerta_estado_pkey do update set avisado = excluded.avisado;

  return motivo || ' (avisado)';
end;
$function$;
