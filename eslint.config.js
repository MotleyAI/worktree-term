import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import tseslint from 'typescript-eslint';

const noDynamicImport = { selector: 'ImportExpression', message: 'Dynamic import() is not allowed in src.' };
const typedViFn = {
  selector: "CallExpression[callee.object.name='vi'][callee.property.name='fn']:not([typeArguments])",
  message: 'vi.fn needs a type argument.',
};

export default tseslint.config(
  { ignores: ['dist/', 'build/', 'coverage/', 'test-results/', 'playwright-report/'] },
  js.configs.recommended,
  tseslint.configs.strictTypeChecked,
  tseslint.configs.stylisticTypeChecked,
  {
    languageOptions: {
      parserOptions: {
        project: [
          './src/protocol/tsconfig.json',
          './tsconfig.node.json',
          './src/web/tsconfig.json',
          './tsconfig.test.json',
          './test/e2e/tsconfig.json',
          './src/web/tsconfig.test.json',
        ],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/explicit-module-boundary-types': 'error',
      '@typescript-eslint/consistent-type-assertions': ['error', { assertionStyle: 'never' }],
      '@typescript-eslint/switch-exhaustiveness-check': 'error',
      '@typescript-eslint/ban-ts-comment': ['error', { 'ts-expect-error': 'allow-with-description' }],
      'no-restricted-syntax': ['error', typedViFn],
    },
  },
  {
    files: ['src/**/*.ts', 'src/**/*.tsx'],
    rules: {
      '@typescript-eslint/no-require-imports': 'error',
      'no-restricted-syntax': ['error', noDynamicImport, typedViFn],
    },
  },
  { files: ['**/*.js'], extends: [tseslint.configs.disableTypeChecked] },
  prettier,
);
