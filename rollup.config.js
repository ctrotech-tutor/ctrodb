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
      sourcemap: true,
    },
    {
      // ES Module (for modern browsers and bundlers)
      file: pkg.module,
      format: 'esm',
      sourcemap: true,
    },
    {
      // **NEW** UMD (Universal Module Definition) for browser <script> tag
      file: 'dist/ctrodb.umd.js', // The path for the UMD file
      format: 'umd',
      name: 'CtroDB', // The global variable name to be created in the browser
      sourcemap: true,
    }
  ],

  // The plugins we are using
  plugins: [
    nodeResolve(),
    terser()
  ]
};
