const eslint = require('@eslint/js')
const tseslint = require('typescript-eslint')
const figmaPlugin = require('@figma/eslint-plugin-figma-plugins')

module.exports = tseslint.config(
  eslint.configs.recommended,
  // @typescript-eslint/recommended-type-checked is too aggressive for
  // plugin code, so we stick with the non-type-checked recommended set.
  tseslint.configs.recommended,
  {
    languageOptions: {
      // The @figma/figma-plugins recommended set includes type-aware rules
      // (e.g. dynamic-page-find-method-advice), so the parser needs a TS
      // program. tsconfig.eslint.json covers all source dirs, not just the
      // narrow `include` in the build tsconfig.
      parserOptions: {
        project: './tsconfig.eslint.json',
        tsconfigRootDir: __dirname,
      },
    },
    plugins: {
      '@figma/figma-plugins': figmaPlugin,
    },
    rules: {
      ...figmaPlugin.configs.recommended.rules,
      // allow underscore-prefixing of unused variables
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
        },
      ],
    },
  },
  {
    // The UI runs in an iframe that has no `figma` global — reaching for it
    // there is a runtime crash, not a type error, and tsconfig's project-wide
    // `types: ["plugin-typings"]` means TypeScript will happily allow it. This
    // is the mechanical guard. src/code.ts is the sandbox entry point and the
    // one legitimate exception, despite living under src/.
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    ignores: ['src/code.ts'],
    rules: {
      'no-restricted-globals': [
        'error',
        {
          name: 'figma',
          message:
            'The UI iframe has no figma global. Send a message to the sandbox instead — see services/MessageListeners.ts.',
        },
      ],
    },
  },
  {
    files: ['scripts/**/*.mjs'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: { project: false },
      globals: {
        console: 'readonly',
        process: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextDecoder: 'readonly',
        TextEncoder: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
      },
    },
  },
  {
    ignores: ['dist-beta', 'dist', 'spike', 'eslint.config.js', 'webpack.config.js'],
  },
)
