# Agent Guidelines for edge-referral-server

## Build/Test/Lint Commands

- `npm run build` - Build TypeScript to lib/ using Sucrase
- `npm run test` - Run all tests with Mocha
- `npm run lint` - Run ESLint on all files
- `npm run fix` - Auto-fix ESLint issues
- `npm run types` - Run TypeScript type checking
- `npm start` - Start development server with Sucrase
- Single test: `npx mocha -r sucrase/register 'test/specific-test.ts'`

## Code Style

- Uses TypeScript with strict mode enabled
- ESLint with standard-kit/prettier config
- Import sorting with simple-import-sort plugin (alphabetical)
- Prettier for formatting
- Use `async/await` over Promises
- Prefer `const` over `let`, avoid `var`
- Use explicit return types for functions
- Error handling with try/catch blocks

## Project Structure

- Source: `src/` (TypeScript)
- Build output: `lib/` (JavaScript)
- Tests: `test/` (Mocha with Chai)
- Database modules: `src/db/`
- Routes: `src/routes/`
- Types: `src/types/`
