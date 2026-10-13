import { useState } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { MessageSquare, Shield, Send } from "lucide-react";
import { useCoordinatorAgentStore } from "../stores/useCoordinatorAgentStore";

export function CoordinatorInteractionDialog() {
  const { pendingInteraction, respondToInteraction } = useCoordinatorAgentStore();
  const [answer, setAnswer] = useState("");

  if (!pendingInteraction) return null;

  const handleAnswerSubmit = () => {
    if (!answer.trim()) return;
    respondToInteraction(pendingInteraction.interactionId, { type: "ask_question", answer: answer.trim() });
    setAnswer("");
  };

  const handleConfirmation = (approved: boolean) => {
    respondToInteraction(pendingInteraction.interactionId, { type: "request_confirmation", approved });
  };

  const isQuestion = pendingInteraction.type === "ask_question";

  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 bg-black/60 backdrop-blur-sm z-[60]"
      />
      <motion.div
        initial={{ opacity: 0, scale: 0.95 }}
        animate={{ opacity: 1, scale: 1 }}
        exit={{ opacity: 0, scale: 0.95 }}
        className="fixed inset-0 z-[60] flex items-center justify-center pointer-events-none"
      >
        <div className="pointer-events-auto w-full max-w-md mx-4">
          <div className="bg-surface rounded-xl border border-border shadow-2xl overflow-hidden">
            {/* Header */}
            <div className="px-5 py-4 border-b border-border flex items-center gap-3">
              <div className="w-8 h-8 rounded-lg bg-orange-500/20 flex items-center justify-center">
                {isQuestion ? (
                  <MessageSquare className="w-4 h-4 text-orange-400" />
                ) : (
                  <Shield className="w-4 h-4 text-yellow-400" />
                )}
              </div>
              <div>
                <h3 className="text-sm font-medium text-white">
                  {isQuestion ? "Coordinator Question" : "Coordinator Needs Approval"}
                </h3>
                <p className="text-[10px] text-zinc-500">Workspace Coordinator needs your input</p>
              </div>
            </div>

            {/* Content */}
            <div className="p-5">
              {pendingInteraction.type === "ask_question" && (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-300">{pendingInteraction.question}</p>
                  {pendingInteraction.context && (
                    <p className="text-xs text-zinc-500 bg-canvas rounded-md p-2 font-mono">{pendingInteraction.context}</p>
                  )}
                  <div className="flex gap-2">
                    <input
                      type="text"
                      value={answer}
                      onChange={(e) => setAnswer(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleAnswerSubmit();
                        }
                      }}
                      placeholder="Type your answer..."
                      autoFocus
                      className="flex-1 px-3 py-2 rounded-md bg-canvas border border-border text-white text-sm placeholder-zinc-600 focus:outline-none focus:border-zinc-500 transition-colors"
                    />
                    <button
                      onClick={handleAnswerSubmit}
                      disabled={!answer.trim()}
                      className="px-3 py-2 rounded-md bg-orange-600 text-white text-sm font-medium hover:bg-orange-500 disabled:opacity-50 transition-colors"
                    >
                      <Send className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              )}

              {pendingInteraction.type === "request_confirmation" && (
                <div className="space-y-3">
                  <p className="text-sm text-zinc-300">{pendingInteraction.action}</p>
                  <div className="bg-canvas rounded-md p-2 font-mono text-xs text-zinc-400 whitespace-pre-wrap break-words max-h-48 overflow-y-auto">
                    {pendingInteraction.detail}
                  </div>
                  {pendingInteraction.reason && <p className="text-xs text-zinc-500">{pendingInteraction.reason}</p>}
                  <div className="flex gap-2">
                    <button
                      onClick={() => handleConfirmation(false)}
                      className="flex-1 px-3 py-2 rounded-md text-sm text-zinc-400 hover:text-white bg-canvas border border-border hover:border-zinc-500 transition-colors"
                    >
                      Deny
                    </button>
                    <button
                      onClick={() => handleConfirmation(true)}
                      className="flex-1 px-3 py-2 rounded-md text-sm font-medium bg-orange-600 text-white hover:bg-orange-500 transition-colors"
                    >
                      Approve
                    </button>
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>
      </motion.div>
    </AnimatePresence>,
    document.body,
  );
}
