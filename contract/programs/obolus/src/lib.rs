use anchor_lang::prelude::*;
use anchor_spl::token::{self, Token, TokenAccount, Transfer};

declare_id!("9CQph7JCyba9uWBRGoDmpiGSnZn2gtvqLBTMF7CYKJzK"); // replaced after `anchor deploy`

#[program]
pub mod obolus {
    use super::*;

    /// Accept a USDC SPL token payment for an order.
    /// Transfers `amount` USDC from the agent's token account to the treasury.
    /// Emits a PaymentReceived event that the backend watcher picks up.
    pub fn accept_usdc(
        ctx: Context<AcceptUsdc>,
        order_id: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ObolusError::ZeroAmount);

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from:      ctx.accounts.payer_usdc.to_account_info(),
                    to:        ctx.accounts.treasury_usdc.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
        )?;

        emit!(PaymentReceived {
            order_id,
            payer: ctx.accounts.payer.key(),
            amount,
            asset: PaymentAsset::Usdc,
        });

        Ok(())
    }

    /// Accept a native SOL payment for an order.
    /// Transfers `amount` lamports from the agent's wallet to the treasury.
    /// Emits a PaymentReceived event that the backend watcher picks up.
    pub fn accept_sol(
        ctx: Context<AcceptSol>,
        order_id: [u8; 32],
        amount: u64,
    ) -> Result<()> {
        require!(amount > 0, ObolusError::ZeroAmount);

        let ix = anchor_lang::solana_program::system_instruction::transfer(
            &ctx.accounts.payer.key(),
            &ctx.accounts.treasury.key(),
            amount,
        );
        anchor_lang::solana_program::program::invoke(
            &ix,
            &[
                ctx.accounts.payer.to_account_info(),
                ctx.accounts.treasury.to_account_info(),
            ],
        )?;

        emit!(PaymentReceived {
            order_id,
            payer: ctx.accounts.payer.key(),
            amount,
            asset: PaymentAsset::Sol,
        });

        Ok(())
    }
}

// ── Accounts ─────────────────────────────────────────────────────────────────

#[derive(Accounts)]
pub struct AcceptUsdc<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// Agent's USDC token account (source)
    #[account(
        mut,
        constraint = payer_usdc.owner == payer.key() @ ObolusError::InvalidTokenOwner,
    )]
    pub payer_usdc: Account<'info, TokenAccount>,

    /// Treasury USDC token account (destination)
    #[account(
        mut,
        constraint = treasury_usdc.owner == treasury.key() @ ObolusError::InvalidTreasury,
    )]
    pub treasury_usdc: Account<'info, TokenAccount>,

    /// CHECK: treasury wallet — only used as owner check for treasury_usdc
    pub treasury: UncheckedAccount<'info>,

    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct AcceptSol<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,

    /// CHECK: treasury system account receiving SOL
    #[account(mut)]
    pub treasury: UncheckedAccount<'info>,

    pub system_program: Program<'info, System>,
}

// ── Events ────────────────────────────────────────────────────────────────────

#[derive(AnchorSerialize, AnchorDeserialize, Clone, PartialEq, Eq)]
pub enum PaymentAsset {
    Usdc,
    Sol,
}

#[event]
pub struct PaymentReceived {
    /// UTF-8 order UUID packed into 32 bytes
    pub order_id: [u8; 32],
    /// Agent's wallet that sent the payment
    pub payer: Pubkey,
    /// Amount in smallest units (USDC: 6 decimals, SOL: lamports)
    pub amount: u64,
    /// Which asset was paid
    pub asset: PaymentAsset,
}

// ── Errors ────────────────────────────────────────────────────────────────────

#[error_code]
pub enum ObolusError {
    #[msg("Amount must be greater than zero")]
    ZeroAmount,
    #[msg("Token account owner does not match payer")]
    InvalidTokenOwner,
    #[msg("Treasury token account owner does not match treasury")]
    InvalidTreasury,
}
