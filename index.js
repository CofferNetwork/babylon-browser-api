const express = require("express");
const app = express();
const cors = require("cors");
const morgan = require("morgan");
const _ = require("lodash");
const { Address } = require("@cmdcode/tapscript");
const bitcoin = require("bitcoinjs-lib");

const providers = require("./finality-providers.json");

app.use(morgan("combined")).use(express.json()).use(cors());

const { MongoClient } = require("mongodb");

async function bootstrap() {
  const client = new MongoClient(
    `mongodb://localhost:27017/staking-api-service`
  );
  await client.connect();

  app.get(`/v3/stats/staker`, async (req, res, next) => {
    const { staker_address, pi = "1", pn = "20" } = req.query;

    const staker_stats = client
      .db("staking-api-service")
      .collection("staker_stats");

    const delegations = client
      .db("staking-api-service")
      .collection("delegations");

    const pkAddress = client
      .db("staking-api-service")
      .collection("pk_address_mappings");

    const fpStats = client
      .db("staking-api-service")
      .collection("finality_providers_stats");

    const all = await staker_stats.countDocuments();
    if (!staker_address) {
      const data = await staker_stats
        .find()
        .sort({ active_tvl: -1 })
        .limit(+pn)
        .skip((+pi - 1) * +pn)
        .toArray();
      const dids = data.map((d) => d._id);
      const d = await delegations
        .find({ staker_pk_hex: { $in: dids } })
        .toArray();

      const e = await pkAddress.find({ _id: { $in: dids } }).toArray();

      for (const i of data) {
        const des = d.filter((_d) => {
          return _d.staker_pk_hex === i._id;
        });

        const dese = e.find((_d) => {
          return _d._id === i._id;
        });
        i.staker_address = dese?.taproot;

        const fpks = new Set(des.map((d) => d.finality_provider_pk_hex));
        const fps = providers.finality_providers.filter((p) =>
          fpks.has(p.eots_pk)
        );
        i.providers = fps;
      }
      res.json({
        data: {
          items: data,
          total: all,
          pi: +pi,
          pn: +pn,
        },
        msg: "",
        code: 200,
      });
      return;
    }

    const mapping = await pkAddress.findOne({
      $or: [
        { taproot: staker_address },
        { native_segwit_even: staker_address },
        { native_segwit_odd: staker_address },
      ],
    });

    if (!mapping) {
      res.json({
        code: 400,
        data: null,
        msg: "no staker_address found",
      });
    }

    const stakerPk = mapping._id;

    const stakerStats = await staker_stats.findOne({ _id: stakerPk });
    const delegationsItems = await delegations
      .find({ staker_pk_hex: stakerPk })
      .limit(+pn)
      .skip((+pi - 1) * +pn)
      .sort({ "staking_tx.start_timestamp": -1 })
      .toArray();

    delegationsItems.forEach((item) => {
      item.to_address = p2trAddress(item.finality_provider_pk_hex);
    });

    stakerStats.delegations = delegationsItems;
    stakerStats.staker_address = staker_address;

    const _fpPks = await delegations
      .find({ staker_pk_hex: stakerPk })
      .project({ finality_provider_pk_hex: 1 })
      .toArray();
    const fpPks = _fpPks.map((p) => p.finality_provider_pk_hex);

    const fpPksItem = await fpStats.find({ _id: { $in: fpPks } }).toArray();
    let totalFPActive = 0;
    for (const item of fpPksItem) {
      totalFPActive += item.active_tvl;
    }

    const prs = providers.finality_providers
      .filter((fp) => {
        return fpPks.includes(fp.eots_pk);
      })
      .map((fp) => {
        return fp.description.moniker;
      });
    stakerStats.finality_providers = prs;
    stakerStats.total = stakerStats.total_delegations;
    stakerStats.pi = +pi;
    stakerStats.pn = +pn;

    res.json({
      code: 200,
      msg: "",
      data: stakerStats,
    });
  });

  app.get(`/v3/finality_providers`, async (req, res, next) => {
    const { pi = "1", pn = "20", fp } = req.query;

    const fppks = providers.finality_providers.map((p) => {
      return p.eots_pk;
    });

    const fpStats = client
      .db("staking-api-service")
      .collection("finality_providers_stats");

    const stats = await fpStats.find({ _id: { $in: fppks } }).toArray();

    const byId = _.keyBy(stats, "_id");

    if (fp) {
      const found = providers.finality_providers.find((p) => p.eots_pk === fp);
      const response = {
        data: null,
        msg: "",
        code: 200,
      };
      if (!found) {
        response.msg = "provider not found";
        response.data = null;
        response.code = 400;
      }
      response.data = found;
      res.json(response);
    }

    const items = providers.finality_providers.slice(
      (+pi - 1) * +pn,
      (+pi - 1) * +pn + +pn
    );

    items.forEach((i) => {
      i.total_delegations = byId[i.eots_pk]?.total_delegations;
      i.active_tvl = byId[i.eots_pk]?.active_tvl;
      i.total_tvl = byId[i.eots_pk]?.total_tvl;
    });

    res.json({
      data: {
        items: items,
        total: providers.finality_providers.length,
        pi: +pi,
        pn: +pn,
      },
      code: 200,
      msg: "",
    });
  });

  app.listen(3080, () => {
    console.log("server start at 3080");
  });
}

bootstrap().catch((err) => {
  console.log(err);
  process.exit(1);
});

function p2trAddress(pubKey, network = bitcoin.networks.bitcoin) {
  const address = Address.p2tr.fromPubKey(pubKey, "main");
  return address;
}
