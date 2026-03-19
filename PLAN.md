# Live Opros — Interactive Quiz System for Training Sessions

## Concept
Real-time interactive quiz platform for NMTech employee training.
Presenter controls the flow, participants answer on their devices, results appear live.

---

## Architecture

```
┌─────────────────┐     WebSocket      ┌──────────────┐
│  /admin          │◄──────────────────►│              │
│  Presenter panel │                    │   Node.js    │
└─────────────────┘                    │   Server     │
                                       │              │
┌─────────────────┐     WebSocket      │  port 3002   │
│  /display        │◄──────────────────►│              │
│  Projector screen│                    │  SQLite DB   │
└─────────────────┘                    │              │
                                       └──────┬───────┘
┌─────────────────┐     WebSocket             │
│  /               │◄─────────────────────────┘
│  Participant     │  (x 30-50 connections)
└─────────────────┘
```

### Stack
- **Backend:** Node.js + Express + ws (WebSocket)
- **Database:** SQLite (better-sqlite3) — single file, easy backup/export
- **Frontend:** Vanilla HTML/CSS/JS (same design system as landing)
- **Hosting:** VPS 5.129.251.26, port 3002, PM2
- **Export:** xlsx (SheetJS) for Excel export

---

## Three Interfaces

### 1. Participant Page (`/`)
- Clean, mobile-friendly, big buttons
- Flow: enter name → wait for question → answer → see result → wait for next
- Question types:
  - **Single choice** (radio buttons, 2-6 options)
  - **Multiple choice** (checkboxes)
  - **Text input** (for prompts, free-form answers)
  - **Rating scale** (1-5 or 1-10)
- Shows: timer countdown, "waiting for next question...", correct answer reveal
- No login/password — just name (or anonymous)

### 2. Admin Panel (`/admin`)
- **Before session:**
  - Create/edit quiz (blocks = modules, questions inside each)
  - Set correct answers, explanations, timers
  - Preview questions
- **During session:**
  - See connected participants count
  - "Start Question" button → pushes question to all participants
  - Live answer stats (how many answered, distribution)
  - "Reveal Answer" button → shows correct answer + explanation to everyone
  - "Next Question" button
  - "End Block" → shows block summary
- **After session:**
  - View all responses
  - Export to Excel (.xlsx)
  - Per-participant breakdown
  - Per-question stats

### 3. Projector Display (`/display`)
- Full-screen, designed for projector (big fonts, dark/light theme)
- Shows in sync with admin actions:
  - Question text + options (no correct answer highlighted)
  - Live histogram of answers (bars animate as people answer)
  - Timer countdown
  - Reveal: correct answer highlighted green, wrong red, explanation text
  - Between questions: participant count, leaderboard (optional)

---

## Data Model

### Quiz
```
quiz {
  id, title, description, created_at
  blocks: [
    {
      id, title (e.g. "Module 1"), order
      questions: [
        {
          id, type (choice|multi|text|scale),
          text, options[], correct_answer,
          explanation, time_limit_sec,
          order
        }
      ]
    }
  ]
}
```

### Session (one run of a quiz)
```
session {
  id, quiz_id, status (waiting|active|finished),
  current_block, current_question, started_at
}
```

### Participant
```
participant {
  id, session_id, name, connected_at
}
```

### Response
```
response {
  id, session_id, participant_id, question_id,
  answer, is_correct, answered_at
}
```

---

## WebSocket Events

### Server → Participant
- `session:waiting` — "waiting for presenter to start"
- `question:show` — question data (text, options, timer)
- `question:lock` — time's up, no more answers
- `question:reveal` — correct answer + explanation
- `block:end` — block summary

### Participant → Server
- `participant:join` — {name}
- `answer:submit` — {question_id, answer}

### Server → Admin
- `stats:live` — real-time answer distribution
- `participant:count` — connected count

### Admin → Server
- `question:start` — push current question
- `question:reveal` — reveal answer
- `question:next` — advance to next
- `block:start` — start a block
- `session:start` / `session:end`

### Server → Display
- Same as Participant + `stats:live` for histogram

---

## Live Session Flow

```
ADMIN                    PARTICIPANTS              DISPLAY
  │                          │                        │
  │ Start Session            │                        │
  ├─────────────────────────►│  "Welcome, waiting..." │
  │                          │                        ├── QR code + "Join now"
  │                          │                        │
  │ Start Question 1         │                        │
  ├─────────────────────────►│  Question appears      │
  │                          │  Timer: 30s            ├── Question + timer
  │                          │                        │
  │  ◄── answers flow in ───►│  Tap answer            │
  │  Live stats updating     │                        ├── Histogram animates
  │                          │                        │
  │ Reveal Answer            │                        │
  ├─────────────────────────►│  See correct + why     │
  │                          │                        ├── Green/red + explanation
  │                          │                        │
  │ (Presenter discusses     │                        │
  │  with the audience)      │                        │
  │                          │                        │
  │ Next Question            │                        │
  ├─────────────────────────►│  Next question appears  │
  │                          │                        ├── ...
  │ ...                      │                        │
  │                          │                        │
  │ End Block                │                        │
  ├─────────────────────────►│  Block summary         │
  │                          │                        ├── Stats, scores
```

---

## Implementation Phases

### Phase 1 — MVP (Day 1)
Core functionality, enough to run the first training session.

- [ ] Project setup: Node.js, Express, WebSocket, SQLite
- [ ] Data model + migrations
- [ ] Participant page: join, answer questions, see results
- [ ] Admin page: load quiz, start/reveal/next flow
- [ ] Display page: question + live histogram + reveal
- [ ] Hardcoded quiz (JSON file) for first session
- [ ] Basic but beautiful UI (reuse landing design tokens)

### Phase 2 — Admin CRUD + Export (Day 2)
Full admin capabilities.

- [ ] Admin: create/edit quizzes in browser
- [ ] Admin: manage blocks and questions (drag to reorder)
- [ ] Question types: choice, multi, text, scale
- [ ] Excel export (.xlsx) with all responses
- [ ] Per-participant results view
- [ ] Session history

### Phase 3 — Polish (Day 3, if time)
Nice-to-haves for wow-effect.

- [ ] Projector display: animated histogram bars
- [ ] Sound effects (correct/wrong/timer)
- [ ] QR code generation on display page
- [ ] Leaderboard (optional gamification)
- [ ] Text question: presenter can highlight/display selected answers live
- [ ] Prompt module: structured prompt editor with fields
- [ ] Dark/light theme toggle for display
- [ ] Mobile-optimized participant view

---

## Deployment

```bash
# On VPS (5.129.251.26)
cd /root
git clone https://github.com/boriseko/live_opros.git
cd live_opros
npm install
npm run build  # if needed

# Add to PM2 ecosystem.config.js:
# { name: "live_opros", cwd: "/root/live_opros", script: "npm", args: "start", env: { PORT: 3002 } }

pm2 start ecosystem.config.js && pm2 save

# Nginx: add location /live_opros/ block
# Access: http://5.129.251.26/live_opros/
# Or direct: http://5.129.251.26:3002/
```

---

## Quiz Content for GenAI Training

### Block 1: After Module 1 (Intro to AI)
5 questions — basics, history, hallucinations, human-in-the-loop

### Block 2: After Module 2 (AI Capabilities)
5 questions — benchmarks, exponential growth, AI levels, cost trends

### Block 3: After Module 3 (Use Cases)
5 questions — industry cases, department applications, approach

### Block 4: After Module 4 (Practical Skills)
5 questions + prompt writing exercises:
- MCQ on prompting techniques
- "Write a prompt for task X" (text input)
- "Fix this prompt" (text input)

### Block 5: After Module 5 (Next Steps)
3 questions + free-form:
- "What will you try first?" (text)
- "Rate your confidence 1-10" (scale)
- Overall feedback (text)

---

## Design Tokens (from Landing)
```css
--accent: #58ccbb
--accent-dark: #3bb8a5
--ink: #2d3b40
--slate: #6b7f86
--ghost: #e8edef
--white: #ffffff
--font: 'Plus Jakarta Sans'
--mono: 'Space Mono'
```

Same visual language as the training landing page — participants feel the connection.
