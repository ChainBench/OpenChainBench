import { OG_SIZE, renderHubOG } from "@/lib/og-hub-template";
import { loadAllAnswers } from "@/lib/answers";

export const runtime = "nodejs";
// Share cards change slowly (title, leader, headline value); crawlers
// and link unfurlers fetch them constantly. Without a revalidate the
// image was regenerated (satori, ~1-2 s of CPU) on every request.
export const revalidate = 86400;
export const size = OG_SIZE;
export const contentType = "image/png";

export default async function OG({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const all = await loadAllAnswers();
  const answer = all.find((a) => a.slug === slug);

  if (!answer) {
    return renderHubOG({
      kicker: "Answers",
      headline: "Questions, answered with data.",
      subline: "Common questions about crypto infrastructure, answered from live OpenChainBench benchmarks.",
    });
  }

  const question = answer.question.endsWith("?") ? answer.question : `${answer.question}?`;

  return renderHubOG({
    kicker: "Answered by data",
    headline: question.length > 60 ? question.slice(0, 57) + "..." : question,
    subline: answer.seo_description ?? answer.short_answer.slice(0, 120),
  });
}
