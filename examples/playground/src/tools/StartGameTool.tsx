import { useMcpTool } from "webmcp-react";
import { z } from "zod";
import type { Difficulty } from "../game/engine";

interface Props {
  onStart: (difficulty: Difficulty) => void;
}

export function StartGameTool({ onStart }: Props) {
  useMcpTool({
    name: "start_game",
    description: "Start a new Wordle game. Normal mode: guess any valid 5-letter word each turn. Hard mode: green letters must stay in the same position and yellow letters must be reused in every subsequent guess.",
    input: z.object({
      difficulty: z.enum(["normal", "hard"]).describe("Normal: any valid word is accepted each turn. Hard: confirmed letters (green in same position, yellow somewhere) must appear in all future guesses."),
    }),
    handler: async ({ difficulty }) => {
      onStart(difficulty);
      return {
        content: [{ type: "text", text: `New game started on ${difficulty} mode. Guess the 5-letter word in 6 attempts. Use the guess_word tool to make guesses.` }],
      };
    },
  });
  return null;
}
