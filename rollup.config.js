// hydrodb/rollup.config.js

import { nodeResolve } from '@rollup/plugin-node-resolve';
import { terser } from 'rollup-plugin-terser';

// We get the package.json file to read metadata from it
import pkg from './package.json';

export default {
  // The entry point of our library
  input: 'src/index.js',

  // The output configuration
  output: [
    {
      // CommonJS (for Node.js and older bundlers)
      file: pkg.main,
      format: 'cjs',
      sourcemap: true, // Generate source maps for easier debugging
    },
    {
      // ES Module (for modern browsers and bundlers)
      file: pkg.module,
      format: 'esm',
      sourcemap: true,
    }
  ],

  // The plugins we are using
  plugins: [
    nodeResolve(), // Helps Rollup find modules
    terser()       // Minifies the output code
  ]
};
