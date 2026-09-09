/**
 * Configuración de la web.
 *
 * La clave publicable va aquí a propósito: está diseñada para vivir en el
 * bundle de un navegador. Lo que protege los datos no es esconderla, es el
 * RLS — `parada`, `llegada_actual`, `serie` y `horario` dan lectura pública y
 * no tienen ninguna política de escritura.
 *
 * Lo que NO puede aparecer nunca aquí: la clave `sb_secret_` de Supabase (se
 * salta el RLS) y la `x-api-key` de la NTA.
 */
export const entorno = {
  supabaseUrl: 'https://ihtyzacidpvnvcnfocen.supabase.co',
  supabaseKey: 'sb_publishable_HMvaKOJQkFn3INzSsI6t7g_bDJwCy3W',

  /** Cada cuánto refresca la pantalla. El cron escribe cada minuto. */
  refrescoMs: 20_000,

  /**
   * WhatsApp para el feedback directo. En formato internacional sin `+` ni
   * espacios, que es lo que quiere `wa.me`: 34 (España) + el número.
   * Va a propósito en el bundle público; es el precio de ofrecer WhatsApp.
   */
  whatsapp: '34600797224',
};
