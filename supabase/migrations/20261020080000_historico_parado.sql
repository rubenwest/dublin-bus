-- El histórico, parado (2026-10-20). Ver CLAUDE.md, "El histórico, parado".
--
-- No cabe en el plan gratuito y la decisión es no pagar. Los datos se
-- vaciaron a mano (`truncate serie`, `truncate paso_archivado`) después de
-- volcarlos a datos/; aquí sólo queda lo que es esquema: el cron de la poda
-- diaria sobra sin nada que podar.
--
-- Se quedan `paso_archivado`, `paso_predicho_crudo` y `podar_serie()`: vacíos
-- no cuestan nada, y son lo que hay que volver a programar si se enciende.
-- Y se queda `podar-historial-cron`, que no tiene que ver con el histórico:
-- sin él `cron.job_run_details` vuelve a los 88 MB.

select cron.unschedule('podar-serie')
 where exists (select 1 from cron.job where jobname = 'podar-serie');
