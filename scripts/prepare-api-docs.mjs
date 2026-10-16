import { cp, mkdir, rm } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const require = createRequire(import.meta.url);
const { version } = require('swagger-ui-dist/package.json');
const destination = join(process.cwd(), 'public/vendor/swagger-ui');
await rm(destination, { recursive: true, force: true });
await mkdir(join(destination, version), { recursive: true });
for (const file of ['swagger-ui-bundle.js', 'swagger-ui-bundle.js.LICENSE.txt', 'LICENSE']) {
	await cp(require.resolve(`swagger-ui-dist/${file}`), join(destination, version, file));
}
