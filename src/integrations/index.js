// =============================================================
// Destinos GPS activos
// =============================================================
// Para agregar un destino nuevo:
//   1. Crear src/integrations/<cliente>.js con defineIntegration() (ver base.js; wise.js es
//      el ejemplo de envío por lote y bermann.js el de un POST por vehículo).
//   2. Agregarlo a esta lista.
//   3. Documentar sus variables en .env.example y APIS.md.
//   4. Frontend: agregar el id a ClientId (api.service.ts), la ruta y el menú.
import falabella from './falabella.js';
import wise from './wise.js';
import drivin from './drivin.js';
import bermann from './bermann.js';
import ds from './ds.js';
import qanalytics from './qanalytics.js';
import cvxr from './cvxr.js';

export const integrations = [falabella, wise, drivin, bermann, ds, qanalytics, cvxr];
