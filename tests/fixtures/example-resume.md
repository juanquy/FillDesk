# Sam Okafor

Staff Data Engineer · sam.okafor@example.com · +1 (206) 555-0148 · Seattle, WA
linkedin.com/in/sam-okafor-example · github.com/samokafor-example · samokafor.example.com

## Summary

Data engineer with nine years building the pipelines and warehouses behind
consumer products. Owns ingestion through to dashboards, has led two team
migrations off batch ETL to streaming, and mentors engineers who are new to the
field. Comfortable being the person who talks to both the analytics team and the
infrastructure team.

## Skills

Python, SQL, Kafka, Airflow, dbt, Snowflake, Spark, DuckDB, AWS (S3, Lambda,
ECS, Redshift), Terraform, Postgres, Docker, Kubernetes, CI/CD, data modelling,
schema evolution, data quality, incident response, technical writing

## Experience

**Acme Analytics · Seattle, WA | Staff Data Engineer | Mar 2022 – Present**

- Rebuilt event ingestion on Kafka and Airflow, cutting time-to-dashboard for the
  product team from 26 hours to 45 minutes.
- Led the move from a 400-step batch ETL system to dbt models in Snowflake, retiring
  60% of the jobs and 30% of the warehouse spend.
- Set up schema-on-read contracts and data-quality checks that caught 14 upstream
  breaks before they hit customer dashboards.
- Wrote the on-call runbook for the data platform and mentored three engineers
  through their first production incidents.

**Brightpath Health · Remote | Senior Data Engineer | Jun 2019 – Feb 2022**

- Built the HIPAA-scoped analytics zone that let the clinical team self-serve
  without exposing patient identifiers.
- Migrated 1.1 billion rows from on-prem Postgres into Redshift with zero downtime
  cutover over two weekends.
- Introduced Airflow and CI checks for DAGs, dropping failed nightly runs from
  18% to under 2%.

**Civic Ledger · Chicago, IL | Data Engineer | Aug 2016 – May 2019**

- Designed the first star schema the company had, replacing 90 hand-written
  reporting queries with 12 governed models.
- Automated a manual CSV reconciliation that had cost the finance team two days a
  week.

## Education

University of Illinois at Urbana-Champaign — B.S. Computer Science, 2016

## Selected Projects

- `pipeline-dojo` — open-source teaching repo for data-engineering interviews,
  1.4k stars.
- Conference talk, "Schema contracts without the ceremony", PyData Seattle 2024.
