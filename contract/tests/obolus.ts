import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { Obolus } from "../target/types/obolus";
import {
  createMint,
  createAccount,
  mintTo,
  getAccount,
  TOKEN_PROGRAM_ID,
} from "@solana/spl-token";
import { assert } from "chai";

describe("obolus", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace.Obolus as Program<Obolus>;
  const payer = provider.wallet as anchor.Wallet;

  // Encode a UUID string into a 32-byte array (UTF-8, zero-padded)
  function encodeOrderId(uuid: string): number[] {
    const bytes = Buffer.alloc(32);
    Buffer.from(uuid, "utf8").copy(bytes);
    return Array.from(bytes);
  }

  it("accept_sol transfers lamports to treasury", async () => {
    const treasury = anchor.web3.Keypair.generate();
    const orderId = encodeOrderId("test-order-sol-00000000000000000");
    const amount = new anchor.BN(100_000_000); // 0.1 SOL

    // Airdrop SOL to payer
    const sig = await provider.connection.requestAirdrop(
      payer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    const treasuryBefore = await provider.connection.getBalance(treasury.publicKey);

    await program.methods
      .acceptSol(orderId, amount)
      .accounts({
        payer: payer.publicKey,
        treasury: treasury.publicKey,
        systemProgram: anchor.web3.SystemProgram.programId,
      })
      .rpc();

    const treasuryAfter = await provider.connection.getBalance(treasury.publicKey);
    assert.equal(
      treasuryAfter - treasuryBefore,
      amount.toNumber(),
      "treasury should receive exact lamports"
    );
  });

  it("accept_usdc transfers USDC tokens to treasury", async () => {
    const treasuryWallet = anchor.web3.Keypair.generate();
    const orderId = encodeOrderId("test-order-usdc-0000000000000000");
    const amount = new anchor.BN(10_000_000); // 10 USDC (6 decimals)

    // Airdrop to cover fees
    const sig = await provider.connection.requestAirdrop(
      payer.publicKey,
      2 * anchor.web3.LAMPORTS_PER_SOL
    );
    await provider.connection.confirmTransaction(sig);

    // Create USDC mint
    const usdcMint = await createMint(
      provider.connection,
      payer.payer,
      payer.publicKey,
      null,
      6
    );

    // Create payer token account and mint USDC
    const payerAta = await createAccount(
      provider.connection,
      payer.payer,
      usdcMint,
      payer.publicKey
    );
    await mintTo(
      provider.connection,
      payer.payer,
      usdcMint,
      payerAta,
      payer.publicKey,
      amount.toNumber() * 2
    );

    // Create treasury token account
    const treasuryAta = await createAccount(
      provider.connection,
      payer.payer,
      usdcMint,
      treasuryWallet.publicKey
    );

    const before = await getAccount(provider.connection, treasuryAta);

    await program.methods
      .acceptUsdc(orderId, amount)
      .accounts({
        payer: payer.publicKey,
        payerUsdc: payerAta,
        treasuryUsdc: treasuryAta,
        treasury: treasuryWallet.publicKey,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    const after = await getAccount(provider.connection, treasuryAta);
    assert.equal(
      Number(after.amount) - Number(before.amount),
      amount.toNumber(),
      "treasury should receive exact USDC"
    );
  });

  it("rejects zero amount", async () => {
    const treasury = anchor.web3.Keypair.generate();
    const orderId = encodeOrderId("test-order-zero-000000000000000");

    try {
      await program.methods
        .acceptSol(orderId, new anchor.BN(0))
        .accounts({
          payer: payer.publicKey,
          treasury: treasury.publicKey,
          systemProgram: anchor.web3.SystemProgram.programId,
        })
        .rpc();
      assert.fail("should have thrown");
    } catch (err: any) {
      assert.include(err.message, "ZeroAmount");
    }
  });
});
