// Compiles contracts/Token.sol into the init code the harness sends to
// eth_estimateGas. Run from a directory holding node_modules with
// solc@0.8.24 and @openzeppelin/contracts@5.0.2:
//   npm install solc@0.8.24 @openzeppelin/contracts@5.0.2
//   node compile.js <path/to/Token.sol> <out.hex>
const solc = require("solc");
const fs = require("fs");
const path = require("path");

const src = process.argv[2] || "Token.sol";
const outFile = process.argv[3] || "initcode.hex";
const input = {
  language: "Solidity",
  sources: { "Token.sol": { content: fs.readFileSync(src, "utf8") } },
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // paris: no PUSH0 / MCOPY, so the same bytes deploy on every tracked
    // EVM chain whatever hard fork it has reached.
    evmVersion: "paris",
    // No metadata hash: the bytes are reproducible from source alone.
    metadata: { bytecodeHash: "none" },
    outputSelection: { "*": { "*": ["evm.bytecode.object", "evm.deployedBytecode.object"] } },
  },
};
function findImports(p) {
  try {
    return { contents: fs.readFileSync(path.join("node_modules", p), "utf8") };
  } catch (e) {
    return { error: "not found: " + p };
  }
}
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: findImports }));
for (const e of out.errors || []) console.error(e.formattedMessage);
const c = out.contracts["Token.sol"].Token;
fs.writeFileSync(outFile, c.evm.bytecode.object + "\n");
console.log("solc", solc.version());
console.log("init code bytes", c.evm.bytecode.object.length / 2, "runtime bytes", c.evm.deployedBytecode.object.length / 2);
