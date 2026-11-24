import type { TeamDelivery, TeamMessage } from "@/lib/team-notify";

export function teamRecorder(answers: TeamDelivery[] = []) {
  const sent: TeamMessage[] = [];
  return {
    sent,
    notify: async (message: TeamMessage): Promise<TeamDelivery> => {
      sent.push(message);
      return answers.shift() ?? "sent";
    },
  };
}
