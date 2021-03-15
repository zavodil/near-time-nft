use near_sdk::borsh::{self, BorshDeserialize, BorshSerialize};
use near_sdk::serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet};
use near_sdk::collections::{LookupMap, UnorderedMap, UnorderedSet};
use near_sdk::json_types::ValidAccountId;
use near_sdk::{env, near_bindgen, AccountId, Balance, Promise, StorageUsage};

use crate::internal::*;
pub use crate::mint::*;
pub use crate::nft_core::*;

mod internal;
mod mint;
mod nft_core;

#[global_allocator]
static ALLOC: wee_alloc::WeeAlloc = wee_alloc::WeeAlloc::INIT;

type AccountPairHash = Vec<u8>;
type AccountHash = Vec<u8>;
type Key = String;
type Request = String;
type Response = String;
pub type TokenId = String;

#[derive(BorshDeserialize, BorshSerialize, Serialize, Deserialize)]
#[serde(crate = "near_sdk::serde")]
pub struct Token {
    pub owner_id: AccountId,
    pub metadata: String,
    pub approved_account_ids: HashSet<AccountId>,
}

#[derive(BorshDeserialize, BorshSerialize)]
pub struct AccountPair {
    from_account_id: AccountId,
    to_account_id: AccountId,
}

impl AccountPair {
    pub fn reverse(&self) -> Self {
        Self {
            from_account_id: self.to_account_id.clone(),
            to_account_id: self.from_account_id.clone(),
        }
    }

    pub fn hash(&self) -> AccountPairHash {
        env::sha256(&self.try_to_vec().unwrap())
    }
}

#[near_bindgen]
#[derive(BorshDeserialize, BorshSerialize)]
pub struct Contract {
    requests: UnorderedMap<AccountPairHash, Request>,
    responses: UnorderedMap<AccountPairHash, Response>,
    encryption_public_keys: UnorderedMap<AccountHash, Key>,

    pub tokens_creators: UnorderedMap<TokenId, AccountId>,
    pub tokens_by_id: UnorderedMap<TokenId, Token>,
    pub tokens_per_owner: LookupMap<AccountId, UnorderedSet<TokenId>>,
    pub owner_id: AccountId,
    pub total_supply: u64,
    pub extra_storage_in_bytes_per_token: StorageUsage,
}

impl Default for Contract {
    fn default() -> Self {
        env::panic(b"Not initialized yet.");
    }
}

fn hash_account_id(account_id: &AccountId) -> AccountHash {
    env::sha256(account_id.as_bytes())
}

#[near_bindgen]
impl Contract {
    #[init]
    pub fn new(owner_id: ValidAccountId) -> Self {
        assert!(!env::state_exists(), "Already initialized");
        Self {
            requests: UnorderedMap::new(b"r".to_vec()),
            responses: UnorderedMap::new(b"a".to_vec()),
            encryption_public_keys: UnorderedMap::new(b"k".to_vec()),

            owner_id: owner_id.into(),
            tokens_creators: UnorderedMap::new(b"c".to_vec()),
            tokens_by_id: UnorderedMap::new(b"t".to_vec()),
            tokens_per_owner: LookupMap::new(b"a".to_vec()),
            total_supply: 0,
            extra_storage_in_bytes_per_token: 0,
        }
    }

    #[payable]
    pub fn mint(&mut self, token_id: TokenId, metadata: String) {
        self.tokens_creators.insert(&token_id, &env::predecessor_account_id());
        self.nft_mint(token_id, metadata);
    }

    #[payable]
    pub fn sale_token(&mut self, token_id: TokenId, receiver_id: ValidAccountId) {
        NonFungibleTokenCore::nft_transfer(self, receiver_id, token_id, None, None);
    }

    pub fn get_token(&self, token_id: TokenId) -> Option<Token> {
        self.tokens_by_id.get(&token_id)
    }

    pub fn get_token_creator(&self, token_id: TokenId) -> Option<AccountId> {
        self.tokens_creators.get(&token_id)
    }

    pub fn request_by_token(&mut self, token_id: TokenId, request: Request) {
        let token = self.get_token(token_id).unwrap();
        // TODO if not null
        // TODO if request created later than day of the call to allow secondary market trades
        let to_account_id = token.owner_id;

        let pair = AccountPair {
            from_account_id: env::predecessor_account_id(),
            to_account_id: to_account_id.clone()
        };
        self.requests.insert(&pair.hash(), &request);
        self.responses.remove(&pair.hash());

        env::log(format!("Request sent form {} to {}", env::predecessor_account_id(), to_account_id).as_bytes());
    }

    pub fn get_request_by_token(&self, to_account_id: AccountId, token_id: TokenId) -> Option<Request> {
        //let token = self.get_token(token_id).unwrap();
        // TODO if not null
        // TODO if request created later than day of the call to allow secondary market trades
        //let to_account_id = token.owner_id;
        let from_account_id = self.get_token_creator(token_id).unwrap();

        let pair = AccountPair {
            from_account_id,
            to_account_id,
        };
        self.requests.get(&pair.hash())
    }

    pub fn respond_by_token(&mut self, token_id: TokenId, response: Request) {
        let from_account_id = self.get_token_creator(token_id).unwrap();

        let pair = AccountPair {
            from_account_id: from_account_id.clone(),
            to_account_id: env::predecessor_account_id(),
        };
        self.responses.insert(&pair.hash(), &response);

        env::log(format!("Respond sent form {} to {}", from_account_id, env::predecessor_account_id()).as_bytes());
    }

    pub fn get_response_by_token(&self, from_account_id: AccountId, token_id: TokenId) -> Option<Response> {
        //let from_account_id = self.get_token_creator(token_id).unwrap();
        let token = self.get_token(token_id).unwrap();
        // TODO if not null
        // TODO if request created later than day of the call to allow secondary market trades
        let to_account_id = token.owner_id;


        let pair = AccountPair {
            from_account_id,
            to_account_id,
        };
        self.responses.get(&pair.hash())
    }

    pub fn get_tokens(&self) -> HashMap<TokenId, Token> {
        self.tokens_by_id.iter().collect()
    }


    pub fn set_key(&mut self, key: Key) {
        self.encryption_public_keys.insert(&hash_account_id(&env::predecessor_account_id()), &key);
    }

    pub fn get_key(&self, account_id: AccountId) -> Option<Key> {
        self.encryption_public_keys.get(&hash_account_id(&account_id))
    }

    pub fn get_key_by_token_owner(&self, token_id: TokenId) -> Option<Key> {
        // TODO allow only to token creator?

        let token = self.get_token(token_id).unwrap();
        // TODO if not null
        let account_id = token.owner_id;

        self.encryption_public_keys.get(&hash_account_id(&account_id))
    }

    pub fn get_key_by_token_creator(&self, token_id: TokenId) -> Option<Key> {
        let account_id = self.get_token_creator(token_id).unwrap();
        // TODO if not null

        self.encryption_public_keys.get(&hash_account_id(&account_id))
    }

    pub fn request(&mut self, to_account_id: AccountId, request: Request) {
        let pair = AccountPair {
            from_account_id: env::predecessor_account_id(),
            to_account_id,
        };
        self.requests.insert(&pair.hash(), &request);
        self.responses.remove(&pair.hash());
    }

    pub fn get_request(&self, from_account_id: AccountId, to_account_id: AccountId) -> Option<Request> {
        let pair = AccountPair {
            from_account_id,
            to_account_id,
        };
        self.requests.get(&pair.hash())
    }

    pub fn respond(&mut self, to_account_id: AccountId, response: Request) {
        let pair = AccountPair {
            from_account_id: to_account_id,
            to_account_id: env::predecessor_account_id(),
        };
        self.responses.insert(&pair.hash(), &response);
    }

    pub fn get_response(&self, from_account_id: AccountId, to_account_id: AccountId) -> Option<Response> {
        let pair = AccountPair {
            from_account_id,
            to_account_id,
        };
        self.responses.get(&pair.hash())
    }
}
