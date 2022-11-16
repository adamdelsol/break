import React from "react";
import {
  Connection,
  Keypair,
  PublicKey,
  sendAndConfirmTransaction,
  SystemProgram,
  Transaction,
} from "@solana/web3.js";

import { useServerConfig } from "providers/server/http";
import { useConnection } from "providers/rpc";
import { useWalletState } from "./wallet";
import { getFeePayers, sleep } from "utils";
import { useClientConfig } from "./config";

export type Status =
  | "initializing"
  | "inactive"
  | "creating"
  | "closing"
  | "active";

export interface Config {
  program: PublicKey[];
  feePayerKeypairs: Keypair[];
  accountCapacity: number;
}

interface AccountCosts {
  total: number;
  feeAccountCost: number;
  programAccountCost: number;
}

interface State {
  status: Status;
  ?: Config;
  creationCost?: number;
  deactivate: () => void;
  create: () => Promise<void>;
  close: () => Promise<void>;
}

const StateContext = React.createContext<State | undefined>(undefined);

type Props = { children: React.ReactNode };
export function Provider({ children }: Props) {
  const [costs, setCosts] = React.useState<AccountCosts>();
  const [status, setStatus] = React.useState<Status>("initializing");
  const [, set] = React.useState<Config>();
  const connection = useConnection();
  const wallet = useWalletState().wallet;
  const creationLock = React.useRef(false);
  const calculationCounter = React.useRef(0);
  const breakProgramId = useServerConfig()?.programId;
  const [{ parallelization }] = useClientConfig();

  React.useEffect(() => {
    calculationCounter.current++;
    setStatus("initializing");
    set(undefined);
    if (!connection) return;
    const savedCounter = calculationCounter.current;
    (async () => {
      while (true) {
        try {
          const accountCosts = await calculateCosts(
            connection,
            parallelization
          );
          if (calculationCounter.current === savedCounter) {
            setCosts(accountCosts);
            setStatus((status) => {
              if (status === "initializing") {
                return "inactive";
              }
              return status;
            });
          }
          return;
        } catch (err) {
          console.error("Failed to calculate account costs, retrying", err);
        }

        await sleep(2000);
      }
    })();
  }, [connection, parallelization]);

  const deactivate = React.useCallback(() => {
    if (!creationLock.current) setStatus("inactive");
  }, [creationLock]);

  const close = React.useCallback(async () => {
    if (!connection) {
      throw new Error("Can't close  until connection is valid");
    } else if (!wallet) {
      throw new Error("Can't create  if wallet is not setup");
    } else if (creationLock.current) {
      console.warn("Account closing is locked");
      return;
    } else if (status === "inactive") {
      creationLock.current = true;
      setStatus("closing");
      try {
        await _close(connection, wallet, parallelization);
      } finally {
        setStatus("inactive");
        creationLock.current = false;
      }
    }
  }, [creationLock, status, wallet, connection, parallelization]);

  const create = React.useCallback(async () => {
    if (!connection) {
      throw new Error("Invalid connection");
    } else if (!breakProgramId) {
      throw new Error("Missing break program id");
    } else if (!wallet) {
      throw new Error("Missing wallet");
    } else if (!costs) {
      throw new Error("Calculating costs");
    } else if (creationLock.current) {
      console.warn("Account creation is locked");
      return;
    } else if (status === "inactive") {
      creationLock.current = true;
      setStatus("creating");
      try {
        const new = await _create(
          connection,
          breakProgramId,
          wallet,
          costs,
          parallelization
        );
        set(new);
        setStatus("active");
      } catch (err) {
        console.error("Failed to create ", err);
        set(undefined);
        setStatus("inactive");
      } finally {
        creationLock.current = false;
      }
    } else {
      console.warn("Account creation requires inactive status", status);
    }
  }, [
    creationLock,
    status,
    wallet,
    connection,
    breakProgramId,
    costs,
    parallelization,
  ]);

  const state: State = React.useMemo(
    () => ({
      status,
      ,
      creationCost: costs?.total,
      deactivate,
      close,
      create,
    }),
    [status, , costs, deactivate, close, create]
  );

  return (
    <StateContext.Provider value={state}>{children}</StateContext.Provider>
  );
}

export function useState() {
  const context = React.useContext(StateContext);
  if (!context) {
    throw new Error(`useState must be used within a Provider`);
  }
  return context;
}

const TX_PER_BYTE = 8;

function calculateProgrampace(parallelization: number) {
  return Math.ceil(1000 / parallelization / TX_PER_BYTE);
}

function calculateTransactionsPerAccount(programpace: number) {
  return TX_PER_BYTE * programpace;
}

const _close = async (
  connection: Connection,
  payer: Keypair,
  parallelization: number
): Promise<void> => {
  const tx = new Transaction();
  const feePayers = getFeePayers(parallelization);
  const balances = await Promise.all(
    feePayers.map((feePayer) => {
      return connection.getBalance(feePayer.publicKey);
    })
  );
  for (let i = 0; i < feePayers.length; i++) {
    const feePayer = feePayers[i].publicKey;
    tx.add(
      SystemProgram.transfer({
        fromPubkey: feePayer,
        toPubkey: payer.publicKey,
        lamports: balances[i],
      })
    );
  }

  await sendAndConfirmTransaction(connection, tx, [payer, ...feePayers]);
};

const calculateCosts = async (
  connection: Connection,
  parallelization: number
): Promise<AccountCosts> => {
  const programpace = calculateProgrampace(parallelization);
  const programAccountCost = await connection.getMinimumBalanceForRentExemption(
    programpace
  );
  const feeAccountRent = await connection.getMinimumBalanceForRentExemption(0);
  const { feeCalculator } = await connection.getRecentBlockhash();
  const signatureFee = feeCalculator.lamportsPerSignature;
  const txPerAccount = calculateTransactionsPerAccount(programpace);
  const feeAccountCost = txPerAccount * signatureFee + feeAccountRent;

  return {
    feeAccountCost,
    programAccountCost,
    total: parallelization * (programAccountCost + feeAccountCost),
  };
};

const _createAccountBatch = async (
  connection: Connection,
  breakProgramId: PublicKey,
  payer: Keypair,
  costs: AccountCosts,
  newFeePayers: Keypair[],
  newProgram: Keypair[],
  programpace: number
) => {
  const batchSize = newProgram.length;
  if (batchSize !== newFeePayers.length) {
    throw new Error("Internal error");
  }

  const tx = new Transaction();
  for (let i = 0; i < batchSize; i++) {
    tx.add(
      SystemProgram.createAccount({
        fromPubkey: payer.publicKey,
        newAccountPubkey: newProgram[i].publicKey,
        lamports: costs.programAccountCost,
        space: programpace,
        programId: breakProgramId,
      })
    );
    tx.add(
      SystemProgram.transfer({
        fromPubkey: payer.publicKey,
        toPubkey: newFeePayers[i].publicKey,
        lamports: costs.feeAccountCost,
      })
    );
  }

  let retries = 3;
  while (retries > 0) {
    try {
      await sendAndConfirmTransaction(
        connection,
        tx,
        [payer, ...newProgram],
        { preflightCommitment: "confirmed" }
      );
      break;
    } catch (err) {
      retries -= 1;
      if (retries === 0) {
        throw new Error("Couldn't confirm transaction");
      }
      console.error(
        `Failed to create , retries remaining: ${retries}`,
        err
      );
    }
  }
};

const _create = async (
  connection: Connection,
  breakProgramId: PublicKey,
  payer: Keypair,
  costs: AccountCosts,
  parallelization: number
): Promise<Config> => {
  const programpace = calculateProgrampace(parallelization);
  const feePayers = getFeePayers(parallelization);
  const program = Array(parallelization)
    .fill(0)
    .map(() => new Keypair());

  const BATCH_SIZE = 5; // max size that can fit in one transaction

  let accountIndex = 0;
  while (accountIndex < parallelization) {
    await _createAccountBatch(
      connection,
      breakProgramId,
      payer,
      costs,
      feePayers.slice(accountIndex, accountIndex + BATCH_SIZE),
      program.slice(accountIndex, accountIndex + BATCH_SIZE),
      programpace
    );

    accountIndex += BATCH_SIZE;
  }

  const txPerAccount = calculateTransactionsPerAccount(programpace);
  return {
    accountCapacity: txPerAccount,
    feePayerKeypairs: feePayers,
    program: program.map((a) => a.publicKey),
  };
};
