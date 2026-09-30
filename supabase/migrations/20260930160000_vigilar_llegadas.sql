-- Alerta por correo cuando las llegadas en vivo dejan de casar.
--
-- El 2026-09-20 Dublin Bus cambió sus trip_id y el horario cargado dejó de
-- casar con el feed: 493 de 1.968 paradas con llegadas durante diez días, y la
-- Edge Function devolviendo 200 en todas las pasadas. Nada fallaba, así que
-- nada avisó. Esto mira el resultado, no el código de estado.
--
-- Dos motivos:
--   rancio     llegada_actual lleva más de 15 min sin reescribirse (cron o
--              función caídos). Vale a cualquier hora.
--   cobertura  menos de la mitad de las paradas en vivo tienen llegadas. Solo
--              de 8 a 20 h de Dublín: de madrugada eso es lo normal.
--
-- Un correo por motivo cada 12 h como mucho, y el estado se borra al
-- recuperarse para que la siguiente caída vuelva a avisar.

create table if not exists public.alerta_estado (
  clave   text primary key,
  avisado timestamptz not null default now()
);

-- Sin políticas: solo la lee y la escribe la función, que es SECURITY DEFINER.
alter table public.alerta_estado enable row level security;

create or replace function public.vigilar_llegadas(p_umbral numeric default 0.5)
returns text
language plpgsql
security definer
set search_path to 'public', 'vault', 'net', 'extensions'
as $$
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
  select count(*),
         count(*) filter (where jsonb_array_length(l.llegadas) > 0),
         max(l.generado)
    into total, con, ultima
  from parada p
  left join llegada_actual l on l.stop_id = p.id
  where p.en_vivo;

  if ultima is null or ultima < now() - interval '15 minutes' then
    motivo := 'rancio';
    asunto := 'Dublin Bus: las llegadas no se actualizan';
    cuerpo := 'llegada_actual no se reescribe desde ' ||
              coalesce(to_char(ultima at time zone 'Europe/Dublin', 'YYYY-MM-DD HH24:MI'), 'nunca') ||
              ' (Dublín).' || E'\n\n' ||
              'Mirar cron.job_run_details y net._http_response: el cron o la ' ||
              'Edge Function recolectar están fallando.';
  elsif hora >= 8 and hora < 20 and total > 0 and con < total * p_umbral then
    motivo := 'cobertura';
    asunto := 'Dublin Bus: solo ' || con || ' de ' || total || ' paradas con llegadas';
    cuerpo := 'Solo ' || con || ' de ' || total || ' paradas en vivo tienen llegadas (' ||
              round(100.0 * con / total) || '%).' || E'\n\n' ||
              'Lo más probable es que la NTA haya publicado un estático nuevo y ' ||
              'los trip_id del feed ya no casen con el horario cargado:' || E'\n\n' ||
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
$$;

revoke execute on function public.vigilar_llegadas(numeric) from public, anon, authenticated;

select cron.schedule('vigilar-llegadas', '*/10 * * * *', 'select public.vigilar_llegadas()');
