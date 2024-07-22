import {
  Connection,
  Keypair,
  VersionedTransaction,
  TransactionMessage,
  PublicKey,
  AddressLookupTableProgram,
  SystemProgram,
  AddressLookupTableAccount,
  TransactionInstruction,
} from "@solana/web3.js";
import fetch from "cross-fetch";
import { Wallet } from "@project-serum/anchor";
import bs58 from "bs58";
import {
  quoteRequest,
  generateSwapInstructions,
  convertToTransactionInstructions,
} from "./jupiterApi.js";
import { Helius } from "helius-sdk";

const connection = new Connection(
  "https://devnet.helius-rpc.com/?api-key=29ef56b0-fda0-4d8d-8fde-ca99b0457e86",
);

const mySecret = process.env["SECRET_KEY"];
const signerKeypair = Keypair.fromSecretKey(bs58.decode(mySecret || ""));

const wallet = new Wallet(signerKeypair);

const inputMint = "So11111111111111111111111111111111111111112";
const outputMint = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
const amount = 1000000;
const swapMode = "ExactIn";
const autoSlippage = true;
const maxAutoSlippageBps = 50;
const destinationTokenAccount = wallet.publicKey.toString();

const jupQuoteData = await quoteRequest(
  inputMint,
  outputMint,
  amount,
  swapMode,
  autoSlippage,
  maxAutoSlippageBps,
);

// New code implementing the provided example
const swapInstructionsResponse = await (
  await fetch("https://quote-api.jup.ag/v6/swap-instructions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      quoteResponse: jupQuoteData,
      userPublicKey: signerKeypair.publicKey.toBase58(),
    }),
  })
).json();

if (swapInstructionsResponse.error) {
  throw new Error(
    "Failed to get swap instructions: " + swapInstructionsResponse.error,
  );
}

const {
  tokenLedgerInstruction, // If you are using `useTokenLedger = true`.
  computeBudgetInstructions, // The necessary instructions to setup the compute budget.
  setupInstructions, // Setup missing ATA for the users.
  swapInstruction: swapInstructionPayload, // The actual swap instruction.
  cleanupInstruction, // Unwrap the SOL if `wrapAndUnwrapSol = true`.
  addressLookupTableAddresses, // The lookup table addresses that you can use if you are using versioned transaction.
} = swapInstructionsResponse;

const deserializeInstruction = (instruction) => {
  return new TransactionInstruction({
    programId: new PublicKey(instruction.programId),
    keys: instruction.accounts.map((key) => ({
      pubkey: new PublicKey(key.pubkey),
      isSigner: key.isSigner,
      isWritable: key.isWritable,
    })),
    data: Buffer.from(instruction.data, "base64"),
  });
};

const getAddressLookupTableAccounts = async (keys) => {
  const addressLookupTableAccountInfos =
    await connection.getMultipleAccountsInfo(
      keys.map((key) => new PublicKey(key)),
    );

  return addressLookupTableAccountInfos.reduce((acc, accountInfo, index) => {
    const addressLookupTableAddress = keys[index];
    if (accountInfo) {
      const addressLookupTableAccount = new AddressLookupTableAccount({
        key: new PublicKey(addressLookupTableAddress),
        state: AddressLookupTableAccount.deserialize(accountInfo.data),
      });
      acc.push(addressLookupTableAccount);
    }

    return acc;
  }, []);
};

const addressLookupTableAccounts = await getAddressLookupTableAccounts(
  addressLookupTableAddresses,
);

const { blockhash } = await connection.getLatestBlockhash();
const messageV0 = new TransactionMessage({
  payerKey: wallet.payer,
  recentBlockhash: blockhash,
  instructions: [
    ...computeBudgetInstructions.map(deserializeInstruction),
    ...setupInstructions.map(deserializeInstruction),
    deserializeInstruction(swapInstructionPayload),
    deserializeInstruction(cleanupInstruction),
  ],
}).compileToV0Message(addressLookupTableAccounts);

const transaction = new VersionedTransaction(messageV0);
