import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import reactHooks from 'eslint-plugin-react-hooks';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', 'web/dist/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['**/*.ts', '**/*.tsx'],
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
      '@typescript-eslint/consistent-type-imports': 'error',
    },
  },
  {
    // Règle hexagonale : le domaine ne dépend de rien d'externe.
    files: ['server/src/domain/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*application*', '*infrastructure*'],
              message: 'Le domaine ne doit dépendre ni de la couche application ni de la couche infrastructure.',
            },
          ],
        },
      ],
    },
  },
  {
    // La couche application ne dépend pas de l'infrastructure.
    files: ['server/src/application/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { group: ['*infrastructure*'], message: "La couche application ne doit pas dépendre de l'infrastructure." },
          ],
        },
      ],
    },
  },
  {
    // Règles React hooks (dépendances d'effets, ordre d'appel).
    files: ['web/src/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks },
    rules: {
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
);
