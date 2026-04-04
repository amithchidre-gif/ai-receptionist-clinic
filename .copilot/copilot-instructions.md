# GitHub Copilot — How to Use for This Project

## HOW TO INVOKE EACH MODEL IN VS CODE

In VS Code with GitHub Copilot:
- Open Copilot Chat: CTRL+SHIFT+I (or CMD+SHIFT+I on Mac)
- To select model: click the model selector dropdown in the chat window
- Available models: Claude Sonnet 4.5, Claude Sonnet 4.6, Claude Opus 4.6, GPT-4.1, GPT-4o (Grok not directly available — use free tier separately)

## ALWAYS START EVERY CHAT WITH THIS:

```
Read these files before responding:
- .copilot/rules.md
- .copilot/context.md  
- .copilot/architecture.md

Confirm you have read them before writing any code.
```

## HOW TO ATTACH FILES TO COPILOT CHAT

In Copilot Chat, use # to attach files:
- Type # then start typing the filename
- Select the file from the dropdown
- Copilot will read it as context

Example:
```
#rules.md #context.md #architecture.md
Now implement Step 1.2 as described below...
```

## MODEL SELECTION GUIDE

| Task Type | Model | Why |
|---|---|---|
| State machine, LLM prompts, complex logic | Claude Opus 4.6 | Highest reasoning |
| Auth, voice wiring, multi-step services | Claude Sonnet 4.6 | Strong logic, fast |
| CRUD models, routes, standard services | Claude Sonnet 4.5 | Reliable, efficient |
| Frontend pages, components, styling | GPT-4.1 | Good at React/Next.js |
| Boilerplate, configs, SQL migrations | Grok Fast (free) | Fast + free for simple tasks |

## COPILOT INLINE SUGGESTIONS

For inline code completion (Tab key):
- Works best with clear function signatures and comments
- Type the function signature first, let Copilot complete the body
- Add a JSDoc comment above functions for better suggestions:

```typescript
/**
 * Upserts a patient — finds by clinic + phone, creates if not found.
 * Never logs patient data (PHI).
 */
async function upsertPatient(params: UpsertPatientParams): Promise<UpsertResult>
```

## AGENT MODE (for longer tasks)

Use Copilot Agent mode (the sparkle icon) for:
- Building an entire service file
- Creating a complete page component
- Running terminal commands automatically

In Agent mode, Copilot can:
- Create multiple files
- Run npm install
- Run TypeScript compiler to check for errors

## FILE REFERENCES IN PROMPTS

Always reference the specific file you want Copilot to edit:

```
Edit #appointmentModel.ts to add the getPendingReminders function.
The function should...
```

This prevents Copilot from creating a new file instead of editing the right one.

## AFTER COPILOT GENERATES CODE

Always do these checks:
1. Look for `any` type — replace with proper types
2. Check clinic_id is filtered in every DB query
3. Verify try/catch exists on async functions
4. Check no PHI (patient name, phone, DOB) is in log statements
5. Run TypeScript compiler: `npx tsc --noEmit`

## WHEN COPILOT GETS IT WRONG

If Copilot generates something that breaks rules.md:
1. Highlight the wrong code
2. Press CTRL+I to open inline chat
3. Say: "This violates rules.md — [specific rule]. Fix it."

Common issues:
- Forgot clinic_id filter → "Every query must filter by clinic_id per rules.md"
- Used `any` type → "No any types allowed. Define a proper interface."
- Missing try/catch → "All async functions need try/catch per rules.md"
- Returned wrong format → "All responses must be { success, data } per rules.md"

## KEEPING CONTEXT ALIVE ACROSS SESSIONS

VS Code Copilot does NOT remember previous conversations.
Before starting each session:
1. Open .copilot/context.md
2. Update "CURRENT BUILD STATUS" with what's done
3. Add any TEST_ values you have (clinic ID, JWT token, etc.)
4. Start new Copilot chat with the read files instruction above
