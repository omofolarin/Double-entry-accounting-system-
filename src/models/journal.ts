import { connection, Schema, Document, Model, model, Types } from "mongoose";
import { isValidTransactionKey, ITransaction, transactionModel } from "./transaction";
import type { Book } from "../Book";
import { handleVoidMemo } from "../helper/handleVoidMemo";
import type { IAnyObject } from "../IAnyObject";
import type { IOptions } from "../IOptions";
import { JournalAlreadyVoidedError } from "../errors/JournalAlreadyVoidedError";
import { isPrototypeAttribute } from "../helper/isPrototypeAttribute";

export interface IJournal {
  _id: Types.ObjectId;
  datetime: Date;
  memo: string;
  _transactions: Types.ObjectId[] | ITransaction[];
  book: string;
  voided?: boolean;
  void_reason?: string;
}

const journalSchema = new Schema<IJournal>(
  {
    datetime: Date,
    memo: {
      type: String,
      default: "",
    },
    _transactions: [
      {
        type: Schema.Types.ObjectId,
        ref: "Medici_Transaction",
      },
    ],
    book: String,
    voided: Boolean,
    void_reason: String,
  },
  { id: false, versionKey: false, timestamps: false }
);

function safeSetKeyToMetaObject(key: string, val: unknown, meta: IAnyObject): void {
  if (isPrototypeAttribute(key)) return;
  if (!isValidTransactionKey(key)) meta[key] = val;
}

const voidJournal = async function (book: Book, reason: undefined | null | string, options: IOptions) {
  if (this.voided) {
    throw new JournalAlreadyVoidedError();
  }

  reason = handleVoidMemo(reason, this.memo);

  // Set this to void with reason and also set all associated transactions
  this.voided = true;
  this.void_reason = reason;

  await this.save(options);

  const transactions = await transactionModel.find({ _journal: this._id }, undefined, options).exec();

  for (const tx of transactions) {
    tx.voided = true;
    tx.void_reason = this.void_reason;
  }

  // TODO: replace with updateMany
  await Promise.all(transactions.map((tx) => new transactionModel(tx).save(options)));

  const entry = book.entry(reason, null, this._id);

  for (const transaction of transactions) {
    const newMeta: IAnyObject = {};
    for (const [key, value] of Object.entries(transaction.toObject())) {
      if (key === "meta") {
        for (const [keyMeta, valueMeta] of Object.entries(value)) {
          safeSetKeyToMetaObject(keyMeta, valueMeta, newMeta);
        }
      } else {
        safeSetKeyToMetaObject(key, value, newMeta);
      }
    }

    if (transaction.credit) {
      entry.debit(transaction.account_path, transaction.credit, newMeta);
    }
    if (transaction.debit) {
      entry.credit(transaction.account_path, transaction.debit, newMeta);
    }
  }
  return entry.commit(options);
} as (this: TJournalDocument, book: Book, reason?: undefined | string, options?: IOptions) => Promise<TJournalDocument>;

export type TJournalDocument<T extends IJournal = IJournal> = Omit<Document, "__v" | "id"> &
  T & {
    void: (book: Book, reason?: undefined | null | string, options?: IOptions) => Promise<TJournalDocument<T>>;
  };

type TJournalModel<T extends IJournal = IJournal> = Model<
  T,
  unknown,
  {
    void: (book: Book, reason?: undefined | null | string, options?: IOptions) => Promise<TJournalDocument<T>>;
  }
>;

export let journalModel: TJournalModel;

export function setJournalSchema(schema: Schema, collection?: string) {
  delete connection.models["Medici_Journal"];

  schema.methods.void = voidJournal;

  journalModel = model("Medici_Journal", schema, collection) as TJournalModel;
}

if (!connection.models["Medici_Journal"]) setJournalSchema(journalSchema);
