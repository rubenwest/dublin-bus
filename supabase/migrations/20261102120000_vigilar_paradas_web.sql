-- El aviso de estático caducado lleva los pasos de la recarga, y desde el
-- 2026-11-02 falta uno: la web lee la lista de paradas de paradas.json
-- (scripts/paradas-web.mjs), no de Supabase, así que tras la carga hay que
-- regenerarlo y desplegar. Solo cambia el texto del correo.
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
              '  4. node scripts\trazados.mjs, node scripts\codigos-parada.mjs y' || E'\n' ||
              '     node scripts\paradas-web.mjs' || E'\n' ||
              '  5. commit de web/public y desplegar: la lista de paradas de la web' || E'\n' ||
              '     es paradas.json, no la base';
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
