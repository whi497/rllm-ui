// Mock data for eval UI prototype

export interface EvalSession {
  id: string;
  project: string;
  experiment: string;
  status: "running" | "completed" | "failed" | "crashed";
  created_at: string;
  completed_at: string | null;
}

export interface EvalResultItem {
  idx: number;
  reward: number;
  is_correct: boolean;
  signals: Record<string, number>;
}

export interface EvalResult {
  id: string;
  session_id: string;
  dataset_name: string;
  model: string;
  agent: string;
  score: number;
  total: number;
  correct: number;
  errors: number;
  signal_averages: Record<string, number>;
  items: EvalResultItem[];
}

interface TrajectoryStep {
  observation?: string;
  thought?: string;
  action?: string;
  model_response?: string;
  chat_completions?: Array<{ role: string; content: string }>;
  info?: Record<string, any>;
  reward: number;
  done: boolean;
  [key: string]: any;
}

interface Trajectory {
  uid: string;
  name?: string;
  task?: Record<string, any>;
  reward: number;
  info?: Record<string, any>;
  steps: TrajectoryStep[];
}

export interface EvalEpisode {
  id: string;
  session_id: string;
  step: number;
  task: Record<string, any>;
  is_correct: boolean;
  termination_reason: string | null;
  trajectories: Trajectory[];
  metrics?: Record<string, any>;
  info?: Record<string, any>;
  created_at: string;
}

// ─── Mock Eval Sessions ─────────────────────────────────────────────

export const MOCK_EVAL_SESSIONS: EvalSession[] = [
  {
    id: "eval-1",
    project: "gsm8k",
    experiment: "gpt-5-mini_math-cot_20260304",
    status: "completed",
    created_at: "2026-03-04T10:30:00Z",
    completed_at: "2026-03-04T11:15:00Z",
  },
  {
    id: "eval-2",
    project: "gsm8k",
    experiment: "claude-sonnet_math-cot_20260304",
    status: "completed",
    created_at: "2026-03-04T09:00:00Z",
    completed_at: "2026-03-04T09:52:00Z",
  },
  {
    id: "eval-3",
    project: "gsm8k",
    experiment: "qwen3-8b_math-cot_20260303",
    status: "completed",
    created_at: "2026-03-03T14:00:00Z",
    completed_at: "2026-03-03T15:20:00Z",
  },
  {
    id: "eval-4",
    project: "MATH",
    experiment: "gpt-5-mini_math-cot_20260304",
    status: "completed",
    created_at: "2026-03-04T12:00:00Z",
    completed_at: "2026-03-04T13:45:00Z",
  },
  {
    id: "eval-5",
    project: "HumanEval",
    experiment: "gpt-5-mini_code-sandbox_20260303",
    status: "completed",
    created_at: "2026-03-03T16:00:00Z",
    completed_at: "2026-03-03T16:30:00Z",
  },
  {
    id: "eval-6",
    project: "MATH",
    experiment: "claude-sonnet_math-cot_20260304",
    status: "running",
    created_at: "2026-03-04T14:00:00Z",
    completed_at: null,
  },
];

// ─── Mock Eval Results ──────────────────────────────────────────────

function makeItems(total: number, correct: number, errors: number): EvalResultItem[] {
  const items: EvalResultItem[] = [];
  for (let i = 0; i < Math.min(total, 20); i++) {
    const isCorrect = i < correct * (20 / total);
    items.push({
      idx: i,
      reward: isCorrect ? 1.0 : 0.0,
      is_correct: isCorrect,
      signals: {
        accuracy: isCorrect ? 1.0 : 0.0,
        format: Math.random() > 0.1 ? 1.0 : 0.5,
      },
    });
  }
  return items;
}

export const MOCK_EVAL_RESULTS: EvalResult[] = [
  {
    id: "res-1",
    session_id: "eval-1",
    dataset_name: "gsm8k",
    model: "gpt-5-mini",
    agent: "math-cot",
    score: 0.88,
    total: 500,
    correct: 440,
    errors: 3,
    signal_averages: { accuracy: 0.88, format: 0.95 },
    items: makeItems(500, 440, 3),
  },
  {
    id: "res-2",
    session_id: "eval-2",
    dataset_name: "gsm8k",
    model: "claude-sonnet",
    agent: "math-cot",
    score: 0.92,
    total: 500,
    correct: 460,
    errors: 1,
    signal_averages: { accuracy: 0.92, format: 0.97 },
    items: makeItems(500, 460, 1),
  },
  {
    id: "res-3",
    session_id: "eval-3",
    dataset_name: "gsm8k",
    model: "qwen3-8b",
    agent: "math-cot",
    score: 0.72,
    total: 500,
    correct: 360,
    errors: 8,
    signal_averages: { accuracy: 0.72, format: 0.89 },
    items: makeItems(500, 360, 8),
  },
  {
    id: "res-4",
    session_id: "eval-4",
    dataset_name: "MATH",
    model: "gpt-5-mini",
    agent: "math-cot",
    score: 0.65,
    total: 300,
    correct: 195,
    errors: 5,
    signal_averages: { accuracy: 0.65, format: 0.91 },
    items: makeItems(300, 195, 5),
  },
  {
    id: "res-5",
    session_id: "eval-5",
    dataset_name: "HumanEval",
    model: "gpt-5-mini",
    agent: "code-sandbox",
    score: 0.81,
    total: 164,
    correct: 133,
    errors: 2,
    signal_averages: { accuracy: 0.81, pass_rate: 0.79 },
    items: makeItems(164, 133, 2),
  },
  {
    id: "res-6",
    session_id: "eval-6",
    dataset_name: "MATH",
    model: "claude-sonnet",
    agent: "math-cot",
    score: 0.71,
    total: 300,
    correct: 213,
    errors: 2,
    signal_averages: { accuracy: 0.71, format: 0.94 },
    items: makeItems(300, 213, 2),
  },
];

// ─── Mock Eval Episodes ─────────────────────────────────────────────

export const MOCK_EVAL_EPISODES: Record<string, EvalEpisode[]> = {
  "eval-1": [
    {
      id: "ep-1-0",
      session_id: "eval-1",
      step: 0,
      task: { question: "Janet's ducks lay 16 eggs per day. She eats three for breakfast every morning and bakes muffins for her friends every day with four. She sells every duck egg at the farmers' market daily for $2. How much in dollars does she make every day at the farmers' market?", answer: "18" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-1-0-0",
          reward: 1.0,
          steps: [
            {
              observation: "Janet's ducks lay 16 eggs per day. She eats three for breakfast every morning and bakes muffins for her friends every day with four. She sells every duck egg at the farmers' market daily for $2. How much in dollars does she make every day at the farmers' market?",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Janet's ducks lay 16 eggs per day. She eats three for breakfast every morning and bakes muffins for her friends every day with four. She sells every duck egg at the farmers' market daily for $2. How much in dollars does she make every day at the farmers' market?" },
                { role: "assistant", content: "Let me solve this step by step.\n\n1. Total eggs per day: 16\n2. Eggs eaten for breakfast: 3\n3. Eggs used for muffins: 4\n4. Eggs remaining to sell: 16 - 3 - 4 = 9\n5. Price per egg: $2\n6. Daily earnings: 9 × $2 = $18\n\nThe answer is $18." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T10:30:05Z",
    },
    {
      id: "ep-1-1",
      session_id: "eval-1",
      step: 1,
      task: { question: "A robe takes 2 bolts of blue fiber and half that much white fiber. How many bolts in total does it take?", answer: "3" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-1-1-0",
          reward: 1.0,
          steps: [
            {
              observation: "A robe takes 2 bolts of blue fiber and half that much white fiber. How many bolts in total does it take?",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "A robe takes 2 bolts of blue fiber and half that much white fiber. How many bolts in total does it take?" },
                { role: "assistant", content: "Blue fiber: 2 bolts\nWhite fiber: 2 / 2 = 1 bolt\nTotal: 2 + 1 = 3 bolts\n\nThe answer is 3." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T10:30:10Z",
    },
    {
      id: "ep-1-2",
      session_id: "eval-1",
      step: 2,
      task: { question: "Josh decides to try flipping a house. He buys a house for $80,000 and puts $50,000 in repairs. This increased the value of the house by 150%. How much profit did he make?", answer: "70000" },
      is_correct: false,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-1-2-0",
          reward: 0.0,
          steps: [
            {
              observation: "Josh decides to try flipping a house. He buys a house for $80,000 and puts $50,000 in repairs. This increased the value of the house by 150%. How much profit did he make?",
              reward: 0.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Josh decides to try flipping a house. He buys a house for $80,000 and puts $50,000 in repairs. This increased the value of the house by 150%. How much profit did he make?" },
                { role: "assistant", content: "Let me think step by step.\n\n1. Purchase price: $80,000\n2. Repair costs: $50,000\n3. Total investment: $130,000\n4. Value increase: 150% of $130,000 = $195,000\n5. New value: $130,000 + $195,000 = $325,000\n6. Profit: $325,000 - $130,000 = $195,000\n\nThe answer is $195,000." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T10:30:15Z",
    },
    {
      id: "ep-1-3",
      session_id: "eval-1",
      step: 3,
      task: { question: "Every day, Wendi feeds each of her chickens three cups of mixed chicken feed, containing seeds, mealworms and vegetables to help keep them healthy. She gives the chickens their feed in three separate meals. In the morning, she gives her flock of chickens 15 cups of feed. In the afternoon, she gives her chickens another 25 cups of feed. If each chicken eats 3 cups of feed per day, how many cups of feed does she need to give her chickens in the final meal of the day?", answer: "20" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-1-3-0",
          reward: 1.0,
          steps: [
            {
              observation: "Every day, Wendi feeds each of her chickens three cups of mixed chicken feed...",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Every day, Wendi feeds each of her chickens three cups of mixed chicken feed, containing seeds, mealworms and vegetables to help keep them healthy. She gives the chickens their feed in three separate meals. In the morning, she gives her flock of chickens 15 cups of feed. In the afternoon, she gives her chickens another 25 cups of feed. If each chicken eats 3 cups of feed per day, how many cups of feed does she need to give her chickens in the final meal of the day?" },
                { role: "assistant", content: "Step 1: Find the total cups given so far: 15 + 25 = 40 cups\nStep 2: Find total chickens: Since morning feed is 15 cups and that's about 1/3 of daily feed per chicken... Actually, let me reconsider.\nStep 3: Total daily feed = morning + afternoon + evening\nStep 4: We need to find the number of chickens first. Total morning + afternoon = 40 cups.\nStep 5: Each chicken needs 3 cups total per day across 3 meals.\nStep 6: Total chickens = 40/(2 cups per chicken for first 2 meals)... Let me recalculate.\nStep 7: If 15 + 25 = 40 cups for first two meals, and we assume equal meals of 1 cup each, that gives us 20 chickens.\nStep 8: 20 chickens × 3 cups = 60 total cups needed\nStep 9: Evening meal = 60 - 40 = 20 cups\n\nThe answer is 20." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T10:30:20Z",
    },
    {
      id: "ep-1-4",
      session_id: "eval-1",
      step: 4,
      task: { question: "Kylar went to the store to get water and some apples. The price of each gallon of water is $3. The price of each set of apples is $4.5. If he bought 8 gallons of water and 3 sets of apples, how much did he pay in total?", answer: "37.5" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-1-4-0",
          reward: 1.0,
          steps: [
            {
              observation: "Kylar went to the store to get water and some apples...",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Kylar went to the store to get water and some apples. The price of each gallon of water is $3. The price of each set of apples is $4.5. If he bought 8 gallons of water and 3 sets of apples, how much did he pay in total?" },
                { role: "assistant", content: "Water cost: 8 × $3 = $24\nApples cost: 3 × $4.5 = $13.5\nTotal: $24 + $13.5 = $37.5\n\nThe answer is $37.5." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T10:30:25Z",
    },
  ],
  "eval-2": [
    {
      id: "ep-2-0",
      session_id: "eval-2",
      step: 0,
      task: { question: "Janet's ducks lay 16 eggs per day. She eats three for breakfast every morning and bakes muffins for her friends every day with four. She sells every duck egg at the farmers' market daily for $2. How much in dollars does she make every day at the farmers' market?", answer: "18" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-2-0-0",
          reward: 1.0,
          steps: [
            {
              observation: "Janet's ducks lay 16 eggs per day...",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Janet's ducks lay 16 eggs per day. She eats three for breakfast every morning and bakes muffins for her friends every day with four. She sells every duck egg at the farmers' market daily for $2. How much in dollars does she make every day at the farmers' market?" },
                { role: "assistant", content: "Eggs remaining after personal use: 16 - 3 - 4 = 9 eggs\nDaily revenue: 9 × $2 = $18\n\nThe answer is 18." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T09:00:05Z",
    },
    {
      id: "ep-2-1",
      session_id: "eval-2",
      step: 1,
      task: { question: "A robe takes 2 bolts of blue fiber and half that much white fiber. How many bolts in total does it take?", answer: "3" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-2-1-0",
          reward: 1.0,
          steps: [
            {
              observation: "A robe takes 2 bolts of blue fiber and half that much white fiber...",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "A robe takes 2 bolts of blue fiber and half that much white fiber. How many bolts in total does it take?" },
                { role: "assistant", content: "Blue: 2 bolts\nWhite: 2/2 = 1 bolt\nTotal: 3 bolts\n\nThe answer is 3." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T09:00:10Z",
    },
  ],
  "eval-4": [
    {
      id: "ep-4-0",
      session_id: "eval-4",
      step: 0,
      task: { question: "Find the value of x such that 3x + 7 = 22.", answer: "5" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-4-0-0",
          reward: 1.0,
          steps: [
            {
              observation: "Find the value of x such that 3x + 7 = 22.",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Find the value of x such that 3x + 7 = 22." },
                { role: "assistant", content: "3x + 7 = 22\n3x = 22 - 7\n3x = 15\nx = 5\n\nThe answer is 5." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T12:00:05Z",
    },
    {
      id: "ep-4-1",
      session_id: "eval-4",
      step: 1,
      task: { question: "Compute the determinant of the matrix [[1, 2], [3, 4]].", answer: "-2" },
      is_correct: false,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-4-1-0",
          reward: 0.0,
          steps: [
            {
              observation: "Compute the determinant of the matrix [[1, 2], [3, 4]].",
              reward: 0.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Compute the determinant of the matrix [[1, 2], [3, 4]]." },
                { role: "assistant", content: "det = (1)(4) - (2)(3) = 4 - 6 = -2\n\nWait, let me recalculate. det = 1*4 - 2*3 = 4 - 6 = 2.\n\nThe answer is 2." },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-04T12:00:10Z",
    },
  ],
  "eval-5": [
    {
      id: "ep-5-0",
      session_id: "eval-5",
      step: 0,
      task: { question: "Write a function that returns the sum of two numbers.", answer: "def add(a, b): return a + b" },
      is_correct: true,
      termination_reason: null,
      trajectories: [
        {
          uid: "t-5-0-0",
          reward: 1.0,
          steps: [
            {
              observation: "Write a function that returns the sum of two numbers.",
              reward: 1.0,
              done: true,
              chat_completions: [
                { role: "user", content: "Write a function that returns the sum of two numbers." },
                { role: "assistant", content: "```python\ndef add(a, b):\n    return a + b\n```" },
              ],
            },
          ],
        },
      ],
      created_at: "2026-03-03T16:00:05Z",
    },
  ],
};

// ─── Helpers ────────────────────────────────────────────────────────

export function getEvalResultForSession(sessionId: string): EvalResult | undefined {
  return MOCK_EVAL_RESULTS.find((r) => r.session_id === sessionId);
}

export function getEvalEpisodesForSession(sessionId: string): EvalEpisode[] {
  return MOCK_EVAL_EPISODES[sessionId] ?? [];
}

export function getEvalSessionById(sessionId: string): EvalSession | undefined {
  return MOCK_EVAL_SESSIONS.find((s) => s.id === sessionId);
}

export function getEvalSessionsByDataset(): Record<string, Array<EvalSession & { result: EvalResult }>> {
  const grouped: Record<string, Array<EvalSession & { result: EvalResult }>> = {};
  for (const session of MOCK_EVAL_SESSIONS) {
    const result = MOCK_EVAL_RESULTS.find((r) => r.session_id === session.id);
    if (!result) continue;
    const dataset = session.project;
    if (!grouped[dataset]) grouped[dataset] = [];
    grouped[dataset].push({ ...session, result });
  }
  return grouped;
}
