# Auditoría Web · Codelab

Herramienta gratuita de **Codelab** para analizar cualquier web: velocidad, SEO, accesibilidad y buenas prácticas, con puntuación, métricas de carga y la lista de mejoras ordenada por impacto. Sirve para captar clientes y vender los servicios de auditoría experta, optimización y seguimiento mensual.

- Textos en castellano y catalán (`i18n.js`), tema claro y oscuro.
- El informe se puede descargar en PDF desde el navegador.
- `#ejemplo` al final de la dirección abre directamente el informe de ejemplo.

## Puesta en marcha

Los análisis usan la API gratuita de Google PageSpeed Insights. **Sin clave propia, Google rechaza casi todas las peticiones** y la página muestra el informe de ejemplo con un aviso.

1. Crea una clave en https://developers.google.com/speed/docs/insights/v5/get-started (botón «Get a Key»).
2. En Google Cloud, restríngela a *Sitios web* con el dominio donde está publicada esta página.
3. Pégala en `config.js` (`apiKey`) y cambia también `email` por el correo real.

El informe de ejemplo (`data/`) es un análisis real de consultasyvisitas.pauizel.com hecho con Lighthouse.
