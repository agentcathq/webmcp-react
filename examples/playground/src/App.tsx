import { useState, useCallback, useEffect } from "react";
import { WebMCPProvider, useWebMCPStatus } from "webmcp-react";
import { DevPanel } from "./components/DevPanel";
import { ExtensionBanner } from "./components/ExtensionBanner";
import { Board } from "./components/Board";
import Keyboard from "./components/Keyboard";
import { StartGameTool } from "./tools/StartGameTool";
import { GuessWordTool } from "./tools/GuessWordTool";
import { GameStatusTool } from "./tools/GameStatusTool";
import { HintTool } from "./tools/HintTool";
import { SlowHintTool } from "./tools/SlowHintTool";
import {
  createInitialState,
  getLetterStatuses,
  evaluateGuess,
  validateHardMode,
  MAX_GUESSES,
  WORD_LENGTH,
} from "./game/engine";
import type { GameState, LetterResult, Difficulty } from "./game/engine";
import { getRandomAnswer, isValidWord } from "./data/words";
import "./App.css";

function StatusBadge() {
  const { available } = useWebMCPStatus();
  return (
    <span className={`status-badge ${available ? "online" : ""}`}>
      {available ? "WebMCP Active" : "Loading..."}
    </span>
  );
}

function WordleGame() {
  const [gameState, setGameState] = useState<GameState>(createInitialState);
  const [currentInput, setCurrentInput] = useState("");
  const [message, setMessage] = useState("");
  const [easyMode, setEasyMode] = useState(false);

  const handleStart = useCallback((difficulty: Difficulty) => {
    const answer = getRandomAnswer();
    setGameState({
      phase: "playing",
      targetWord: answer,
      guesses: [],
      difficulty,
      easyMode: false,
    });
    setCurrentInput("");
    setMessage("");
  }, []);

  const handleGuess = useCallback(
    (result: LetterResult[], won: boolean, lost: boolean) => {
      setGameState((prev) => ({
        ...prev,
        guesses: [...prev.guesses, result],
        phase: won ? "won" : lost ? "lost" : prev.phase,
      }));
      setCurrentInput("");
      if (won) {
        setMessage("You won!");
      } else if (lost) {
        setMessage(`Game over! The word was ${gameState.targetWord}.`);
      } else {
        setMessage("");
      }
    },
    [gameState.targetWord],
  );

  const submitGuess = useCallback(() => {
    if (currentInput.length !== WORD_LENGTH) {
      setMessage("Not enough letters");
      return;
    }

    if (!isValidWord(currentInput)) {
      setMessage("Not in word list");
      return;
    }

    if (gameState.difficulty === "hard") {
      const hardModeError = validateHardMode(currentInput, gameState.guesses);
      if (hardModeError) {
        setMessage(hardModeError);
        return;
      }
    }

    const result = evaluateGuess(currentInput, gameState.targetWord);
    const won = result.every((r) => r.status === "correct");
    const lost = !won && gameState.guesses.length + 1 >= MAX_GUESSES;
    handleGuess(result, won, lost);
  }, [currentInput, gameState, handleGuess]);

  const handleKey = useCallback(
    (key: string) => {
      if (gameState.phase !== "playing") return;

      if (key === "ENTER") {
        submitGuess();
        return;
      }

      if (key === "BACK") {
        setCurrentInput((prev) => prev.slice(0, -1));
        return;
      }

      if (/^[A-Z]$/.test(key) && currentInput.length < WORD_LENGTH) {
        setCurrentInput((prev) => prev + key);
      }
    },
    [gameState.phase, currentInput.length, submitGuess],
  );

  // Physical keyboard listener
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;

      if (e.key === "Enter") {
        handleKey("ENTER");
      } else if (e.key === "Backspace") {
        handleKey("BACK");
      } else if (/^[a-zA-Z]$/.test(e.key)) {
        handleKey(e.key.toUpperCase());
      }
    };

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [handleKey]);

  const letterStatuses = getLetterStatuses(gameState.guesses);

  const showStartTool = gameState.phase !== "playing";
  const showPlayingTools = gameState.phase === "playing";
  const showHintTool = showPlayingTools && easyMode;

  return (
    <div className="game-area">
      {/* Conditional tool registration — the key WebMCP demo */}
      {showStartTool && <StartGameTool onStart={handleStart} />}
      {showPlayingTools && (
        <GuessWordTool gameState={gameState} onGuess={handleGuess} />
      )}
      {showPlayingTools && <GameStatusTool gameState={gameState} />}
      {showHintTool && <HintTool gameState={gameState} />}
      <SlowHintTool />

      <header className="game-header">
        <h1>WebMCP Wordle</h1>
        <StatusBadge />
      </header>

      {gameState.phase === "idle" && (
        <div className="start-screen">
          <p className="tagline">
            A Wordle clone powered by{" "}
            <code>webmcp-react</code> — every game action is an MCP tool.
          </p>
          <p className="hint-text">
            Open the <strong>DevPanel</strong> on the right to see tools
            register and unregister as game state changes.
          </p>
          <div className="start-buttons">
            <button
              className="btn btn-primary"
              onClick={() => handleStart("normal")}
            >
              Normal Mode
            </button>
            <button
              className="btn btn-secondary"
              onClick={() => handleStart("hard")}
            >
              Hard Mode
            </button>
          </div>
          <p className="mode-descriptions">
            <strong>Normal:</strong> Guess any valid 5-letter word each turn.
            <br />
            <strong>Hard:</strong> Green letters must stay in the same position and yellow letters must be reused in every subsequent guess.
          </p>
        </div>
      )}

      {gameState.phase === "playing" && (
        <>
          <div className="game-info">
            <span className="guess-counter">
              {gameState.guesses.length} / {MAX_GUESSES}
            </span>
            {gameState.difficulty === "hard" && (
              <span className="hard-badge">HARD</span>
            )}
          </div>
          <Board
            guesses={gameState.guesses}
            currentInput={currentInput}
            phase={gameState.phase}
          />
          {message && <div className="game-message">{message}</div>}
          <Keyboard
            letterStatuses={letterStatuses}
            onKey={handleKey}
            disabled={false}
          />
        </>
      )}

      {(gameState.phase === "won" || gameState.phase === "lost") && (
        <>
          <Board
            guesses={gameState.guesses}
            currentInput=""
            phase={gameState.phase}
          />
          <div className="game-over">
            {gameState.phase === "won" ? (
              <p className="game-over-text win">
                You guessed it in {gameState.guesses.length} attempt
                {gameState.guesses.length !== 1 ? "s" : ""}!
              </p>
            ) : (
              <p className="game-over-text lose">
                The word was <strong>{gameState.targetWord}</strong>.
              </p>
            )}
            <div className="start-buttons">
              <button
                className="btn btn-primary"
                onClick={() => handleStart("normal")}
              >
                Play Again (Normal)
              </button>
              <button
                className="btn btn-secondary"
                onClick={() => handleStart("hard")}
              >
                Play Again (Hard)
              </button>
            </div>
            <p className="mode-descriptions">
              <strong>Normal:</strong> Guess any valid 5-letter word each turn.
              <br />
              <strong>Hard:</strong> Green letters must stay in the same position and yellow letters must be reused in every subsequent guess.
            </p>
          </div>
        </>
      )}

      <label className="easy-mode-toggle">
        <input
          type="checkbox"
          checked={easyMode}
          onChange={(e) => setEasyMode(e.target.checked)}
        />
        Easy mode (enables hint tool)
      </label>
    </div>
  );
}

export default function App() {
  return (
    <WebMCPProvider name="webmcp-wordle" version="1.0">
      <div className="app-shell">
        <ExtensionBanner />
        <div className="app-layout">
          <WordleGame />
          <DevPanel />
        </div>
      </div>
    </WebMCPProvider>
  );
}
