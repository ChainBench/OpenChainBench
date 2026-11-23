import { describe, expect, it } from "bun:test";

import {
  type LeaderCandidate,
  pickChainLeader,
  pickChainTrailer,
} from "@/lib/materialize/per-chain-leader";

/**
 * Les deux cas sont des lectures de production, relevees par l'audit
 * adversarial du bench 311 le 2026-10-30.
 */
const row = (slug: string, p50: number, unranked?: string): LeaderCandidate => ({
  slug,
  ms: { p50 },
  ...(unranked ? { unrankedLabel: unranked } : {}),
});

describe("une ligne publiee hors classement ne mene pas une chaine", () => {
  it("ne couronne pas Alchemy sur l'onglet Robinhood", () => {
    // Alchemy lit 100 sur cette chaine et le board la publie NON CLASSEE,
    // avec sa cause imprimee a cote: la seule methode qu'on ne lui a pas
    // demandee est celle que le reste de la cohorte refuse. La pastille
    // produit disait pourtant "#1 of 5 on Robinhood Chain", et le 5 etait le
    // pool classe, qui n'inclut pas Alchemy: le denominateur decrivait un
    // autre ensemble que le numerateur.
    const chain = [
      row("alchemy", 100, "Provisional"),
      row("quicknode", 88.9),
      row("chainstack", 88.9),
      row("getblock", 77.8),
    ];
    const leader = pickChainLeader(chain, true);
    expect(leader?.slug).not.toBe("alchemy");
  });

  it("n'elit personne quand tous les candidats sont gates", () => {
    const chain = [row("a", 100, "Provisional"), row("b", 90, "Provisional")];
    expect(pickChainLeader(chain, true)).toBeNull();
  });

  it("ne nomme pas non plus une ligne gatee comme la pire", () => {
    // Etre non classee est une affirmation sur la comparabilite, pas un
    // verdict. La pastille de queue se lirait comme un verdict.
    const chain = [row("a", 100), row("gated", 1, "Provisional")];
    expect(pickChainTrailer(chain, true)?.slug).toBe("a");
  });
});

describe("une egalite n'elit personne", () => {
  it("ne donne pas le titre au premier du YAML", () => {
    // Sur Ethereum, quatre providers lisent 100. Le tri est stable, donc le
    // premier declare dans le spec gagnait, et /products/quicknode affichait
    // "#1 of 5" sur cinq chaines pendant que trois egaux n'avaient rien.
    const chain = [
      row("quicknode", 100),
      row("chainstack", 100),
      row("dwellir", 100),
      row("blockmachine", 100),
      row("getblock", 77.8),
    ];
    expect(pickChainLeader(chain, true)).toBeNull();
  });

  it("elit quand le sommet est vraiment seul", () => {
    const chain = [row("a", 100), row("b", 99.9), row("c", 77.8)];
    expect(pickChainLeader(chain, true)?.slug).toBe("a");
  });

  it("applique la meme regle quand le plus bas gagne", () => {
    const tie = [row("a", 12), row("b", 12), row("c", 40)];
    expect(pickChainLeader(tie, false)).toBeNull();
    const clear = [row("a", 11), row("b", 12), row("c", 40)];
    expect(pickChainLeader(clear, false)?.slug).toBe("a");
  });

  it("ignore une egalite plus bas dans le tableau", () => {
    // Deux providers a egalite en troisieme place ne disent rien du premier.
    const chain = [row("a", 100), row("b", 90), row("c", 90)];
    expect(pickChainLeader(chain, true)?.slug).toBe("a");
  });
});

describe("cas limites", () => {
  it("rend null sur une chaine vide", () => {
    expect(pickChainLeader([], true)).toBeNull();
    expect(pickChainTrailer([], false)).toBeNull();
  });

  it("elit un candidat unique", () => {
    expect(pickChainLeader([row("seul", 42)], true)?.slug).toBe("seul");
  });

  it("elit le seul candidat non gate", () => {
    const chain = [row("gated", 100, "Provisional"), row("real", 50)];
    expect(pickChainLeader(chain, true)?.slug).toBe("real");
  });
});
