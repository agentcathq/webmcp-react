import { useMcpTool } from "webmcp-react";
import { z } from "zod";
import type { GameState } from "../game/engine";
import { MAX_GUESSES, getKnownPattern } from "../game/engine";

interface Props {
  gameState: GameState;
}

export function GameStatusTool({ gameState }: Props) {
  useMcpTool({
    name: "get_game_status",
    description: "Get the current status of the Wordle game, including guesses made, remaining attempts, and known letter positions.",
    input: z.object({}),
    annotations: { readOnlyHint: true },
    handler: async () => {
      const guessCount = gameState.guesses.length;
      const remaining = MAX_GUESSES - guessCount;
      const pattern = getKnownPattern(gameState.guesses);
      const previousWords = gameState.guesses
        .map((g) => g.map((r) => r.letter).join("").toUpperCase())
        .join(", ");

      const lines = [
        `Phase: ${gameState.phase}`,
        `Difficulty: ${gameState.difficulty}`,
        `Guesses: ${guessCount} / ${MAX_GUESSES}`,
        `Remaining attempts: ${remaining}`,
        `Known pattern: ${pattern}`,
      ];

      if (previousWords) {
        lines.push(`Previous guesses: ${previousWords}`);
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    },
  });
  return null;
}
