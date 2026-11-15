// Lazy loader for the IronRDP WebAssembly client (vendor/ironrdp, MIT).
import init, * as iron from '../../vendor/ironrdp/rdp_client.js';

let ready;
export function loadIronRdp() {
  if (!ready) {
    ready = init().then(() => {
      try { iron.setup('warn'); } catch { /* already set up */ }
      return iron;
    });
  }
  return ready;
}
