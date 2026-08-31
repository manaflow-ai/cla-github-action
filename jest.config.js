module.exports = {
  clearMocks: true,
  moduleFileExtensions: ['js', 'ts'],
  testEnvironment: 'node',
  testMatch: ['**/*.test.ts'],
  testRunner: 'jest-circus/runner',
  setupFiles: ['<rootDir>/__tests__/testHelpers/setupEnv.ts'],
  // Production bundles the current ESM-only Actions toolkit. Jest 29 runs
  // the TypeScript suite through CommonJS, so unit tests use API-compatible
  // CJS aliases. The subprocess dist tests exercise the production bundle.
  moduleNameMapper: {
    '^@actions/core$': '<rootDir>/node_modules/@actions/core-cjs/lib/core.js',
    '^@actions/github$':
      '<rootDir>/node_modules/@actions/github-cjs/lib/github.js',
    '^@actions/http-client$':
      '<rootDir>/node_modules/@actions/http-client-cjs/lib/index.js',
    '^@actions/http-client/(.*)$':
      '<rootDir>/node_modules/@actions/http-client-cjs/$1.js',
    '^undici$': '<rootDir>/node_modules/undici-cjs/index.js'
  },
  transform: {
    '^.+\\.ts$': [
      'ts-jest',
      {
        diagnostics: false,
        tsconfig: { module: 'commonjs', moduleResolution: 'node' }
      }
    ]
  },
  verbose: true
}
