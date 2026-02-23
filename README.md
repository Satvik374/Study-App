# Study AI - Smart Study Companion

Offline-first study app with Subjects, Chapters, Flashcards, Tests, Analytics, and a new AI Study Teacher.

## Run

1. Install dependencies:

```bash
npm install
```

2. Configure AI provider in `.env` (or start from `.env.example`):

```env
PORT=3000
OPENAI_COMPAT_BASE_URL=https://api.openai.com/v1
OPENAI_COMPAT_MODEL=gpt-4.1-mini
OPENAI_COMPAT_API_KEY=replace_with_your_api_key
```

3. Start app:

```bash
npm start
```

4. Open:

```text
http://localhost:3000
```

## AI Teacher Features

- Personalized teaching based on your in-app study data.
- 1000-line system prompt loaded from `prompts/study_teacher_system_prompt.txt`.
- Supports OpenAI-compatible chat completion APIs through backend proxy (`server.js`).
- Can propose and auto-apply structured data-control actions (subjects, chapters, definitions, Q&A, notes, history, SR data).
- Generates personalized tests from your stored knowledge and weak areas.
- Uses Custom Math Text format:
  - Inline: `[[m: expression ]]`
  - Block:
    - `[[math]]`
    - math lines
    - `[[/math]]`

## Frontend-only mode (no AI backend)

If you only need non-AI features, you can still run static mode:

```bash
npm run start:static
```

AI Teacher requires `npm start` (backend enabled).

## Tech Stack

- HTML5 + CSS3 + Vanilla JavaScript
- LocalStorage for offline data
- Node.js + Express backend proxy for AI calls
