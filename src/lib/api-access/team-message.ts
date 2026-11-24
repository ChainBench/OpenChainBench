import {
  escapeForTeam,
  escapeForTeamMultiline,
  escapeHtmlText,
  plainForSlack,
  plainForSlackMultiline,
  type TeamMessage,
} from "@/lib/team-notify";
import { MAX_PENDING, MAX_USE_CASE, type Requester } from "./contract";

const MAX_FIELD = 300;
const MAX_ESCAPED_USE_CASE = 2 * MAX_USE_CASE;
const NEXT_STEP =
  "Email and site are not verified. Approve or decline the request in " +
  "the CRM: API access, Waiting tab.";

const slackLabel = (label: string) => ({ type: "mrkdwn", text: `*${label}*` });

export function newRequestMessage(requester: Requester): TeamMessage {
  const name = escapeForTeam(requester.name, MAX_FIELD);
  const email = escapeHtmlText(requester.email);
  const site = escapeForTeam(requester.website, MAX_FIELD);
  const useCase = escapeForTeamMultiline(
    requester.useCase,
    MAX_ESCAPED_USE_CASE,
  );
  return {
    telegramHtml:
      `<b>New API key request</b>\n\n` +
      `<b>From</b> <code>${name}</code> ` +
      `(<code>${email}</code>)\n` +
      `<b>Site</b> <code>${site}</code>\n\n` +
      `<b>What they will build</b>\n<pre>${useCase}</pre>\n\n` +
      `<i>${NEXT_STEP}</i>`,
    slack: {
      text: `New API key request from ${name}`,
      blocks: [
        {
          type: "section",
          fields: [
            slackLabel("From"),
            plainForSlack(requester.name, MAX_FIELD),
            slackLabel("Email"),
            plainForSlack(requester.email, MAX_FIELD),
            slackLabel("Site"),
            plainForSlack(requester.website, MAX_FIELD),
          ],
        },
        { type: "section", text: slackLabel("What they will build") },
        {
          type: "section",
          text: plainForSlackMultiline(
            requester.useCase,
            MAX_ESCAPED_USE_CASE,
          ),
        },
        {
          type: "context",
          elements: [
            { type: "mrkdwn", text: NEXT_STEP },
          ],
        },
      ],
    },
  };
}

const QUEUE_FULL =
  `${MAX_PENDING} requests are waiting for review, the most the queue ` +
  "holds, so new requests are refused until some are decided. If they " +
  "are spam, open API access in the CRM and decline them as spam from " +
  "the Waiting tab.";

function notice(title: string, body: string): TeamMessage {
  return {
    telegramHtml: `<b>${title}</b>\n\n${body}`,
    slack: {
      text: title,
      blocks: [
        {
          type: "section",
          text: { type: "mrkdwn", text: `*${title}*\n${body}` },
        },
      ],
    },
  };
}

export const queueFullMessage = () =>
  notice("API key requests are being refused", QUEUE_FULL);

const MORE_REQUESTS =
  "More requests arrived within the hour than this server posts one by " +
  "one. The Waiting tab of API access in the CRM lists them all.";

export const moreRequestsMessage = () =>
  notice("More API key requests", MORE_REQUESTS);
