// Fails the build when models.json is not a valid registry (runs after tsc, against the compiled package).
import { validateRegistry } from '../dist/src/index.js';
import seedModels from '../models.json' with { type: 'json' };

const { models, errors } = validateRegistry(seedModels);
if (errors.length > 0) {
  console.error(`models.json is invalid:\n${errors.map((error) => `- ${error}`).join('\n')}`);
  process.exit(1);
}
console.log(`models.json is valid: ${models.length} models`);
